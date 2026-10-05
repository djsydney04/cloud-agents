use crate::{
    config::{Config, private_write},
    model::{Job, Provider, now},
    store::Store,
};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{process::Command, time::timeout};

#[derive(Clone)]
pub struct Engine {
    pub config: Config,
    pub store: Arc<Mutex<Store>>,
    pub token: Arc<String>,
    pub health: Arc<Mutex<Health>>,
    pub settings: Arc<Mutex<crate::settings::Settings>>,
}
#[derive(Clone, Default, Serialize)]
pub struct Health {
    pub docker_ready: bool,
    pub image_ready: bool,
    pub free_bytes: u64,
    pub last_error: Option<String>,
    pub docker_cpus: Option<u32>,
    pub docker_memory_mb: Option<u32>,
}

pub async fn docker(args: &[String]) -> Result<String> {
    let out = timeout(
        Duration::from_secs(45),
        Command::new("docker")
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("Docker operation timed out")??;
    if !out.status.success() {
        bail!(
            "{}",
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(1500)
                .collect::<String>()
        );
    }
    let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
    if args.first().is_some_and(|s| s == "logs") {
        output.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Ok(output.trim().to_owned())
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
pub fn name(j: &Job) -> String {
    format!("cloud-agents-{}", j.id)
}
fn perms(p: &Path, mode: u32) -> Result<()> {
    fs::set_permissions(p, fs::Permissions::from_mode(mode))?;
    Ok(())
}
impl Engine {
    pub fn new(config: Config) -> Result<Self> {
        let token = fs::read_to_string(config.data_dir.join("token"))?;
        if token.trim().len() < 32 {
            bail!("Host token must contain at least 32 characters");
        }
        let settings_path = config.data_dir.join("settings.json");
        let settings = if settings_path.exists() {
            serde_json::from_slice(&fs::read(settings_path)?)?
        } else {
            crate::settings::Settings::from_config(&config)
        };
        settings.validate()?;
        Ok(Self {
            settings: Arc::new(Mutex::new(settings)),
            store: Arc::new(Mutex::new(Store::open(&config.data_dir.join("state.db"))?)),
            config,
            token: Arc::new(token.trim().into()),
            health: Default::default(),
        })
    }
    pub fn job_dir(&self, id: &str) -> std::path::PathBuf {
        self.config.data_dir.join("jobs").join(id)
    }
    pub fn has_credential(&self, p: &Provider) -> bool {
        let root = self.config.data_dir.join("credentials");
        match p {
            Provider::Smoke => true,
            Provider::Codex => root.join("codex.json").exists() || root.join("openai-key").exists(),
            Provider::Claude => {
                root.join("claude-token").exists() || root.join("anthropic-key").exists()
            }
        }
    }
    fn prepare(&self, j: &Job) -> Result<()> {
        let root = self.job_dir(&j.id);
        fs::create_dir_all(&root)?;
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace)?;
        perms(&workspace, 0o700)?;
        let input = root.join("input");
        fs::create_dir_all(&input)?;
        perms(&input, 0o700)?;
        private_write(&input.join("prompt"), j.request.prompt.as_bytes())?;
        perms(&input.join("prompt"), 0o400)?;
        let secrets = root.join("secrets");
        fs::create_dir_all(&secrets)?;
        perms(&secrets, 0o700)?;
        let mut keys = vec!["github-token"];
        match j.request.provider {
            Provider::Codex => keys.extend(["codex.json", "openai-key"]),
            Provider::Claude => keys.extend(["claude-token", "anthropic-key"]),
            Provider::Smoke => keys.clear(),
        }
        for key in keys {
            let p = self.config.data_dir.join("credentials").join(key);
            if p.exists() {
                fs::copy(p, secrets.join(key))?;
                perms(&secrets.join(key), 0o400)?;
            }
        }
        Ok(())
    }
    pub fn create_args(&self, j: &Job) -> Vec<String> {
        let root = self.job_dir(&j.id);
        let (uid, gid) = crate::config::identity();
        let user = format!("{uid}:{gid}");
        let home = format!("/home/agent:rw,nosuid,nodev,size=256m,uid={uid},gid={gid},mode=700");
        let mut a = strings(&[
            "create",
            "--name",
            &name(j),
            "--label",
            "io.cloud-agents.managed=true",
            "--init",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--user",
            &user,
            "--cpus",
            &j.request.cpus.to_string(),
            "--memory",
            &format!("{}m", j.request.memory_mb),
            "--memory-swap",
            &format!("{}m", j.request.memory_mb),
            "--log-driver",
            "local",
            "--log-opt",
            "max-size=5m",
            "--log-opt",
            "max-file=2",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
            "--tmpfs",
            &home,
        ]);
        for (source, target, readonly) in [
            ("workspace", "/workspace", false),
            ("input", "/run/input", true),
            ("secrets", "/run/secrets", true),
        ] {
            a.extend([
                "--mount".into(),
                format!(
                    "type=bind,src={},dst={}{}",
                    root.join(source).display(),
                    target,
                    if readonly { ",readonly" } else { "" }
                ),
            ]);
        }
        a.extend([
            self.config.image.clone(),
            j.request.provider.name().into(),
            j.request.repository.clone(),
        ]);
        a
    }
    async fn launch(&self, j: &Job) -> Result<()> {
        self.prepare(j)?;
        docker(&self.create_args(j)).await?;
        docker(&strings(&["start", &name(j)])).await?;
        let s = self.store.lock().unwrap();
        let mut current = s.get(&j.id)?;
        if current.status == "starting" {
            current.status = "running".into();
        }
        current.started_at = Some(now());
        s.save(&current)?;
        Ok(())
    }
    fn finish(
        &self,
        id: &str,
        status: &str,
        exit: Option<i64>,
        error: Option<String>,
    ) -> Result<()> {
        let s = self.store.lock().unwrap();
        let mut j = s.get(id)?;
        j.status = status.into();
        j.exit_code = exit;
        j.error = error;
        j.finished_at = Some(now());
        s.save(&j)?;
        let secrets = self.job_dir(id).join("secrets");
        if secrets.exists() {
            fs::remove_dir_all(secrets)?;
        }
        Ok(())
    }
    pub async fn check_health(&self) -> Result<()> {
        let ready = docker(&strings(&["info", "--format", "{{json .}}"])).await;
        let info = ready
            .as_ref()
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
        let image = if ready.is_ok() {
            docker(&strings(&[
                "image",
                "inspect",
                &self.config.image,
                "--format",
                "{{.Id}}",
            ]))
            .await
            .is_ok()
        } else {
            false
        };
        let free = fs2::available_space(&self.config.data_dir)?;
        *self.health.lock().unwrap() = Health {
            docker_cpus: info
                .as_ref()
                .and_then(|v| v["NCPU"].as_u64())
                .map(|n| n as u32),
            docker_memory_mb: info
                .as_ref()
                .and_then(|v| v["MemTotal"].as_u64())
                .map(|n| (n / 1024 / 1024) as u32),
            docker_ready: ready.is_ok(),
            image_ready: image,
            free_bytes: free,
            last_error: ready.as_ref().err().map(ToString::to_string),
        };
        ready?;
        Ok(())
    }
    pub async fn remove_container(&self, j: &Job) -> Result<()> {
        if let Err(error) = docker(&strings(&["rm", "-f", &name(j)])).await {
            // Confirm absence through a successful daemon query, not a failed inspect.
            let names = docker(&strings(&["ps", "-a", "--format", "{{.Names}}"])).await?;
            if names.lines().any(|n| n == name(j)) {
                return Err(error);
            }
        }
        Ok(())
    }
    pub async fn tick(&self) -> Result<()> {
        self.check_health().await?;
        let Health {
            image_ready: image,
            free_bytes: free,
            ..
        } = self.health.lock().unwrap().clone();
        let jobs = self.store.lock().unwrap().list()?;
        for j in jobs.iter().filter(|j| j.active()) {
            let n = name(j);
            if j.status == "cancelling"
                || j.started_at
                    .is_some_and(|t| now() - t >= j.request.timeout_secs as i64)
            {
                self.remove_container(j).await?;
                self.finish(
                    &j.id,
                    if j.status == "cancelling" {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    None,
                    if j.status == "cancelling" {
                        None
                    } else {
                        Some("Run timed out".into())
                    },
                )?;
                continue;
            }
            let inspect = docker(&strings(&["inspect", "--format", "{{json .State}}", &n])).await;
            match inspect {
                Ok(s) => {
                    let state: serde_json::Value = serde_json::from_str(&s)?;
                    if state["Running"].as_bool() == Some(true) {
                        if j.status == "starting" {
                            let s = self.store.lock().unwrap();
                            let mut current = s.get(&j.id)?;
                            if current.status == "starting" {
                                current.status = "running".into();
                                current.started_at.get_or_insert(now());
                                s.save(&current)?;
                            }
                        }
                    } else {
                        let code = state["ExitCode"].as_i64();
                        let message = if state["OOMKilled"].as_bool() == Some(true) {
                            Some("Memory limit exceeded".into())
                        } else if state["Status"] == "created" {
                            Some("Host stopped before container start; submit a new run".into())
                        } else {
                            None
                        };
                        let status = if code == Some(0) && message.is_none() {
                            "succeeded"
                        } else {
                            "failed"
                        };
                        self.finish(&j.id, status, code, message)?;
                    }
                }
                Err(e) => {
                    let names = docker(&strings(&["ps", "-a", "--format", "{{.Names}}"])).await?;
                    if names.lines().any(|n| n == name(j)) {
                        return Err(e);
                    }
                    self.finish(
                        &j.id,
                        "failed",
                        None,
                        Some(format!("Container unavailable: {e}")),
                    )?;
                }
            }
        }
        if !image {
            return Ok(());
        }
        loop {
            let next = {
                // Settings and admission use one lock order: policy, then job store.
                let policy = self.settings.lock().unwrap();
                if policy.paused || free < policy.min_free_gb.saturating_mul(1024 * 1024 * 1024) {
                    break;
                }
                let s = self.store.lock().unwrap();
                let jobs = s.list()?;
                let active: Vec<_> = jobs.iter().filter(|j| j.active()).collect();
                let used_cpu: u32 = active.iter().map(|j| j.request.cpus).sum();
                let used_mem: u32 = active.iter().map(|j| j.request.memory_mb).sum();
                // FIFO admission prevents large jobs starving behind small jobs.
                let next = jobs.iter().rev().find(|j| j.status == "queued");
                match next {
                    Some(j)
                        if active.len() < policy.max_jobs
                            && used_cpu + j.request.cpus <= policy.cpus
                            && used_mem + j.request.memory_mb <= policy.memory_mb =>
                    {
                        let mut j = j.clone();
                        j.status = "starting".into();
                        s.save(&j)?;
                        Some(j)
                    }
                    _ => None,
                }
            };
            let Some(j) = next else { break };
            if let Err(e) = self.launch(&j).await {
                self.remove_container(&j).await?;
                self.finish(&j.id, "failed", None, Some(format!("Launch failed: {e}")))?;
            }
        }
        Ok(())
    }
    pub async fn logs(&self, j: &Job) -> Result<String> {
        if j.status == "queued" {
            return Ok("Waiting for available host capacity…".into());
        }
        let output = docker(&strings(&["logs", "--tail", "500", &name(j)])).await?;
        // Cap the response even when an agent emits exceptionally long lines.
        let mut start = output.len().saturating_sub(512 * 1024);
        while !output.is_char_boundary(start) {
            start += 1;
        }
        Ok(output[start..].to_owned())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[derive(Parser)]
    struct Opt {
        #[command(flatten)]
        config: Config,
    }
    #[test]
    fn container_is_constrained_and_prompt_not_in_command() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = Opt::parse_from(["test", "--data-dir", tmp.path().to_str().unwrap()]).config;
        c.init().unwrap();
        let e = Engine::new(c).unwrap();
        let j = e
            .store
            .lock()
            .unwrap()
            .insert(
                serde_json::from_str(r#"{"provider":"smoke","prompt":"secret prompt"}"#).unwrap(),
            )
            .unwrap();
        let a = e.create_args(&j).join(" ");
        assert!(a.contains("--cap-drop=ALL"));
        assert!(a.contains("--read-only"));
        assert!(a.contains("--memory-swap"));
        assert!(!a.contains("secret prompt"));
        assert!(!a.contains("docker.sock"));
    }
}
