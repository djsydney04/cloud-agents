//! One host setup path, shared by the installer and desktop app.
use crate::{
    config::{self, Config},
    engine,
    settings::Settings,
};
use anyhow::{Context, Result, bail};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use tokio::process::Command;

pub async fn prepare(c: &Config) -> Result<()> {
    eprintln!("Checking Docker…");
    let info = engine::docker(&["info".into(), "--format".into(), "{{json .}}".into()])
        .await.context("Start Docker Desktop, then try again. On Linux, start Docker Engine and allow your user to access it.")?;
    let info: serde_json::Value = serde_json::from_str(&info)?;
    let settings = c.data_dir.join("settings.json");
    if !settings.exists() {
        let mut budget = Settings::from_config(c);
        budget.cpus = budget
            .cpus
            .min((info["NCPU"].as_u64().unwrap_or(2) as u32 / 2).max(1));
        let memory = info["MemTotal"].as_u64().unwrap_or(1024 * 1024 * 1024) / (1024 * 1024);
        budget.memory_mb = budget
            .memory_mb
            .min(((memory / 2 / 256) * 256).max(256) as u32);
        budget.max_jobs = budget.max_jobs.min(budget.cpus as usize);
        config::private_write(&settings, &serde_json::to_vec(&budget)?)?;
    }
    if engine::docker(&["image".into(), "inspect".into(), c.image.clone()])
        .await
        .is_err()
    {
        if c.image != "cloud-agents-sandbox:0.1.0" {
            bail!(
                "Custom sandbox image is unavailable; build or pull {} first",
                c.image
            );
        }
        eprintln!(
            "Preparing your agent workspace. The first setup downloads its tools and can take a few minutes…"
        );
        let context = c.data_dir.join("sandbox-build");
        config::private_dir(&context)?;
        for (name, bytes) in [
            (
                "Dockerfile",
                include_bytes!("../sandbox/Dockerfile").as_slice(),
            ),
            (
                "entrypoint.sh",
                include_bytes!("../sandbox/entrypoint.sh").as_slice(),
            ),
            (
                "askpass.sh",
                include_bytes!("../sandbox/askpass.sh").as_slice(),
            ),
        ] {
            fs::write(context.join(name), bytes)?;
        }
        let status = Command::new(config::docker_path())
            .args(["build", "-t", &c.image])
            .arg(&context)
            .kill_on_drop(true)
            .status()
            .await
            .context("Could not start Docker")?;
        if !status.success() {
            bail!("Workspace preparation failed. Check your internet connection and try again.");
        }
    }
    eprintln!("Workspace ready.");
    Ok(())
}

fn service_name(c: &Config) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{}:{}", c.data_dir.display(), c.bind).as_bytes());
    format!(
        "dev.cloudagents.host.{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn unit_quote(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}
fn arguments(c: &Config, binary: &Path) -> Vec<String> {
    vec![
        binary.display().to_string(),
        "--data-dir".into(),
        c.data_dir.display().to_string(),
        "--bind".into(),
        c.bind.to_string(),
        "--image".into(),
        c.image.clone(),
        "serve".into(),
    ]
}
fn service_file(c: &Config) -> Result<std::path::PathBuf> {
    let home = std::env::var("HOME")?;
    let name = service_name(c);
    Ok(if cfg!(target_os = "macos") {
        Path::new(&home).join(format!("Library/LaunchAgents/{name}.plist"))
    } else {
        Path::new(&home).join(format!(".config/systemd/user/{name}.service"))
    })
}
async fn control(args: &[&str]) -> Result<()> {
    let (program, args) = args.split_first().context("Missing service command")?;
    let result = Command::new(program).args(args).output().await?;
    if !result.status.success() {
        bail!(
            "{}: {}",
            program,
            String::from_utf8_lossy(&result.stderr).trim()
        );
    }
    Ok(())
}
pub async fn stop(c: &Config) -> Result<()> {
    let name = service_name(c);
    if cfg!(target_os = "macos") {
        control(&[
            "launchctl",
            "bootout",
            &format!("gui/{}/{name}", config::identity().0),
        ])
        .await?;
    } else {
        control(&[
            "systemctl",
            "--user",
            "disable",
            "--now",
            &format!("{name}.service"),
        ])
        .await?;
    }
    let file = service_file(c)?;
    if file.exists() {
        fs::remove_file(file)?;
    }
    eprintln!("Host stopped. Agent workspaces and running containers are preserved.");
    Ok(())
}
async fn running(c: &Config) -> bool {
    let Ok(token) = fs::read_to_string(c.data_dir.join("token")) else {
        return false;
    };
    reqwest::Client::new()
        .get(format!("http://{}/api/host", c.bind))
        .bearer_auth(token.trim())
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}
pub async fn start(c: &Config, open: bool) -> Result<()> {
    if !running(c).await {
        prepare(c).await?;
        // Service binaries live outside the downloaded app/repository, so moving an app
        // or deleting its installer cannot break startup at login.
        let bin = c.data_dir.join("bin");
        config::private_dir(&bin)?;
        let binary = bin.join("cloud-agents");
        let staging = bin.join("cloud-agents.next");
        fs::copy(std::env::current_exe()?, &staging)?;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))?;
        fs::rename(staging, &binary)?;
        let args = arguments(c, &binary);
        if args.iter().any(|s| s.chars().any(char::is_control)) {
            bail!("Service paths must not contain control characters");
        }
        let name = service_name(c);
        let file = service_file(c)?;
        fs::create_dir_all(file.parent().unwrap())?;
        let executable_path = config::executable_path();
        if cfg!(target_os = "macos") {
            let plist = format!(
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",
                xml(&name),
                args.iter()
                    .map(|a| format!("<string>{}</string>", xml(a)))
                    .collect::<String>(),
                xml(&executable_path),
                xml(&c.data_dir.join("host.log").display().to_string()),
                xml(&c.data_dir.join("host-error.log").display().to_string())
            );
            config::private_write(&file, plist.as_bytes())?;
            let domain = format!("gui/{}", config::identity().0);
            let _ = control(&["launchctl", "bootout", &format!("{domain}/{name}")]).await;
            control(&[
                "launchctl",
                "bootstrap",
                &domain,
                &file.display().to_string(),
            ])
            .await?;
        } else {
            let unit = format!(
                "[Unit]\nDescription=Cloud Agents\nAfter=network-online.target\n\n[Service]\nExecStart={}\nEnvironment={}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
                args.iter()
                    .map(|a| unit_quote(a))
                    .collect::<Vec<_>>()
                    .join(" "),
                unit_quote(&format!("PATH={executable_path}"))
            );
            config::private_write(&file, unit.as_bytes())?;
            control(&["systemctl", "--user", "daemon-reload"]).await?;
            control(&["systemctl", "--user", "enable", "--now", &format!("{name}.service")]).await.context("A user systemd session is required. You can instead run `cloud-agents setup && cloud-agents serve`.")?;
        }
        for _ in 0..60 {
            if running(c).await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        if !running(c).await {
            bail!(
                "Host did not start. Check {}",
                c.data_dir.join("host-error.log").display()
            );
        }
    }
    println!(
        "Cloud Agents is ready at http://{}. It will start automatically when you sign in.",
        c.bind
    );
    if open {
        let token = fs::read_to_string(c.data_dir.join("token"))?;
        let url = format!("http://{}/#token={}", c.bind, token.trim());
        let launcher = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        if Command::new(launcher).arg(url).status().await.is_err() {
            eprintln!(
                "Open http://{} and use `cloud-agents token` to connect.",
                c.bind
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_arguments_cannot_escape_xml_or_systemd() {
        assert_eq!(xml("a<&\"'>"), "a&lt;&amp;&quot;&apos;&gt;");
        assert_eq!(unit_quote("a%\"\\$b"), "\"a%%\\\"\\\\$$b\"");
    }
}
