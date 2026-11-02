use anyhow::{Context, Result, bail};
use clap::Args;
use rand::RngCore;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
#[derive(Clone, Debug, Args)]
pub struct Config {
    #[arg(
        long,
        env = "CLOUD_AGENTS_HOME",
        default_value = "~/.local/share/cloud-agents"
    )]
    pub data_dir: PathBuf,
    /// Absolute data directory as seen by the local Docker daemon.
    #[arg(long, env = "CLOUD_AGENTS_DOCKER_DATA_DIR")]
    pub docker_data_dir: Option<PathBuf>,
    /// Docker network for agent runs; omitted to retain Docker's default bridge.
    #[arg(long, env = "CLOUD_AGENTS_DOCKER_NETWORK")]
    pub docker_network: Option<String>,
    #[arg(long, env = "CLOUD_AGENTS_BIND", default_value = "127.0.0.1:7420")]
    pub bind: std::net::SocketAddr,
    #[arg(long, env = "CLOUD_AGENTS_CPUS", default_value_t = 4)]
    pub cpus: u32,
    #[arg(long, env = "CLOUD_AGENTS_MEMORY_MB", default_value_t = 8192)]
    pub memory_mb: u32,
    #[arg(long, env = "CLOUD_AGENTS_MAX_JOBS", default_value_t = 2)]
    pub max_jobs: usize,
    #[arg(long, env = "CLOUD_AGENTS_MIN_FREE_GB", default_value_t = 5)]
    pub min_free_gb: u64,
    #[arg(
        long,
        env = "CLOUD_AGENTS_IMAGE",
        default_value = "cloud-agents-sandbox:0.1.0"
    )]
    pub image: String,
}
pub fn private_dir(p: &Path) -> Result<()> {
    fs::create_dir_all(p)?;
    fs::set_permissions(p, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
pub fn private_write(p: &Path, bytes: &[u8]) -> Result<()> {
    let temp = p.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(temp, p)?;
    Ok(())
}
impl Config {
    pub fn init(&mut self) -> Result<()> {
        if let Some(s) = self.data_dir.to_str().and_then(|s| s.strip_prefix("~/")) {
            self.data_dir = PathBuf::from(std::env::var("HOME")?).join(s);
        }
        if identity().0 == 0 {
            bail!("Run the host as an ordinary user, not root");
        }
        private_dir(&self.data_dir)?;
        self.data_dir = fs::canonicalize(&self.data_dir)?;
        validate_mount_path(&self.data_dir)?;
        if let Some(path) = &self.docker_data_dir {
            validate_mount_path(path)?;
        }
        if self.docker_network.as_ref().is_some_and(|network| {
            network.is_empty()
                || !network.starts_with(|c: char| c.is_ascii_alphanumeric())
                || !network
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        }) {
            bail!("Docker network must be a network name or ID");
        }
        if !self.bind.ip().is_loopback() {
            bail!("Bind to loopback; use SSH forwarding or Tailscale Serve for remote access");
        }
        if self.cpus == 0
            || self.cpus > 1024
            || self.memory_mb < 256
            || self.memory_mb > 16_777_216
            || self.max_jobs == 0
            || self.max_jobs > 1024
        {
            bail!("Invalid resource budget");
        }
        for d in ["jobs", "credentials"] {
            private_dir(&self.data_dir.join(d))?;
        }
        let token = self.data_dir.join("token");
        if !token.exists() {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            private_write(
                &token,
                bytes
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
                    .as_bytes(),
            )?;
        }
        Ok(())
    }

    pub fn docker_mount_path(&self, path: &Path) -> Result<PathBuf> {
        let relative = path
            .strip_prefix(&self.data_dir)
            .context("Docker mount must be inside the data directory")?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            bail!("Docker mount must not traverse outside the data directory");
        }
        let root = self.docker_data_dir.as_ref().unwrap_or(&self.data_dir);
        let mapped = root.join(relative);
        validate_mount_path(&mapped)?;
        Ok(mapped)
    }
}

fn validate_mount_path(path: &Path) -> Result<()> {
    let text = path.to_str().context("Data paths must be valid UTF-8")?;
    if !path.is_absolute()
        || text.chars().any(|c| c == ',' || c.is_control())
        || path.components().any(|c| c == Component::ParentDir)
    {
        bail!(
            "Data paths must be absolute and contain no commas, control characters or parent traversal"
        );
    }
    Ok(())
}

// Match bind-mounted workspace ownership on both Linux and Docker Desktop.
pub fn identity() -> (u32, u32) {
    unsafe { (libc::geteuid(), libc::getegid()) }
}

/// GUI apps and login services do not inherit an interactive shell's PATH.
pub fn executable_path() -> String {
    format!(
        "{}:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin",
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
    )
}
pub fn docker_path() -> PathBuf {
    std::env::split_paths(&executable_path())
        .map(|p| p.join("docker"))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("docker"))
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
    fn daemon_mount_mapping_preserves_local_paths_and_rejects_escape() {
        let mut c = Opt::parse_from(["test", "--data-dir", "/container data"]).config;
        let local = Path::new("/container data/jobs/one/workspace");
        assert_eq!(c.docker_mount_path(local).unwrap(), local);
        c.docker_data_dir = Some("/host data".into());
        assert_eq!(
            c.docker_mount_path(local).unwrap(),
            Path::new("/host data/jobs/one/workspace")
        );
        assert_eq!(
            c.docker_mount_path(&c.data_dir.join("login-codex"))
                .unwrap(),
            Path::new("/host data/login-codex")
        );
        assert_eq!(c.data_dir, Path::new("/container data"));
        assert!(
            c.docker_mount_path(Path::new("/container data-other/file"))
                .is_err()
        );
        assert!(
            c.docker_mount_path(Path::new("/container data/../outside"))
                .is_err()
        );
        assert!(
            c.docker_mount_path(Path::new("/container data/jobs/bad,readonly"))
                .is_err()
        );
    }

    #[test]
    fn daemon_root_validation_does_not_require_a_local_directory() {
        assert!(validate_mount_path(Path::new("/daemon-only data/cloud-agents")).is_ok());
        for invalid in [
            "relative",
            "/data,readonly",
            "/data\nother",
            "/data\tother",
            "/data/../other",
        ] {
            assert!(
                validate_mount_path(Path::new(invalid)).is_err(),
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn public_listener_is_still_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = Opt::parse_from([
            "test",
            "--data-dir",
            tmp.path().to_str().unwrap(),
            "--bind",
            "0.0.0.0:7420",
        ])
        .config;
        assert!(c.init().unwrap_err().to_string().contains("loopback"));
    }

    #[test]
    fn explicit_docker_network_must_be_a_name_or_id() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = Opt::parse_from(["test", "--data-dir", tmp.path().to_str().unwrap()]).config;
        for network in ["", "--host", "host\nother", "container:other"] {
            c.docker_network = Some(network.into());
            assert!(c.init().unwrap_err().to_string().contains("Docker network"));
        }
        for network in ["host", "bridge", "none", "private_network.v1-2", "a"] {
            c.docker_network = Some(network.into());
            c.init().unwrap();
        }
    }
}
