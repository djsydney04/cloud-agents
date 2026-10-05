use anyhow::{Result, bail};
use clap::Args;
use rand::RngCore;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, Args)]
pub struct Config {
    #[arg(
        long,
        env = "CLOUD_AGENTS_HOME",
        default_value = "~/.local/share/cloud-agents"
    )]
    pub data_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1:7420")]
    pub bind: std::net::SocketAddr,
    #[arg(long, default_value_t = 4)]
    pub cpus: u32,
    #[arg(long, default_value_t = 8192)]
    pub memory_mb: u32,
    #[arg(long, default_value_t = 2)]
    pub max_jobs: usize,
    #[arg(long, default_value_t = 5)]
    pub min_free_gb: u64,
    #[arg(long, default_value = "cloud-agents-sandbox:0.1.0")]
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
        if self.data_dir.to_string_lossy().contains([',', '\n']) {
            bail!("Data path must not contain commas or newlines");
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
}

// Match bind-mounted workspace ownership on both Linux and Docker Desktop.
pub fn identity() -> (u32, u32) {
    unsafe { (libc::geteuid(), libc::getegid()) }
}
