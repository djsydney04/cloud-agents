use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Codex,
    Claude,
    Smoke,
}
impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Smoke => "smoke",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewJob {
    pub provider: Provider,
    pub prompt: String,
    #[serde(default)]
    pub repository: String,
    #[serde(default = "default_cpu")]
    pub cpus: u32,
    #[serde(default = "default_memory")]
    pub memory_mb: u32,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
}
fn default_cpu() -> u32 {
    1
}
fn default_memory() -> u32 {
    2048
}
fn default_timeout() -> u32 {
    1800
}
impl NewJob {
    pub fn validate(&self, cpus: u32, memory: u32) -> Result<()> {
        if self.prompt.trim().is_empty() || self.prompt.len() > 32000 {
            bail!("Prompt must contain 1–32000 bytes");
        }
        if self.cpus == 0 || self.cpus > cpus || self.memory_mb < 256 || self.memory_mb > memory {
            bail!("Requested resources exceed host budget or minimums");
        }
        if !(10..=86400).contains(&self.timeout_secs) {
            bail!("Timeout must be 10–86400 seconds");
        }
        if !self.repository.is_empty() {
            // Narrow clone surface: no arbitrary schemes, userinfo, options, local paths or LAN hosts.
            let path = self
                .repository
                .strip_prefix("https://github.com/")
                .ok_or_else(|| anyhow::anyhow!("Use an HTTPS github.com repository URL"))?;
            let parts: Vec<_> = path.trim_end_matches(".git").split('/').collect();
            if parts.len() != 2
                || parts.iter().any(|p| {
                    p.is_empty()
                        || *p == "."
                        || *p == ".."
                        || !p
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
                })
            {
                bail!("Invalid GitHub owner/repository");
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    #[serde(flatten)]
    pub request: NewJob,
    pub status: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub exit_code: Option<i64>,
    pub error: Option<String>,
}
impl Job {
    pub fn active(&self) -> bool {
        matches!(self.status.as_str(), "starting" | "running" | "cancelling")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(repo: &str) -> NewJob {
        NewJob {
            provider: Provider::Smoke,
            prompt: "hello".into(),
            repository: repo.into(),
            cpus: 1,
            memory_mb: 256,
            timeout_secs: 10,
        }
    }
    #[test]
    fn validates_clone_boundary() {
        for url in [
            "file:///etc",
            "--upload-pack=evil",
            "https://github.com/a/b/../c",
            "https://github.com.evil/a/b",
            "https://u:p@github.com/a/b",
            "https://github.com/a/b?x",
            "https://github.com/../b",
        ] {
            assert!(job(url).validate(2, 2048).is_err(), "{url}");
        }
        assert!(
            job("https://github.com/openai/codex.git")
                .validate(2, 2048)
                .is_ok()
        );
    }
    #[test]
    fn enforces_budgets() {
        let mut j = job("");
        j.cpus = 3;
        assert!(j.validate(2, 2048).is_err());
        j.cpus = 1;
        j.timeout_secs = 0;
        assert!(j.validate(2, 2048).is_err());
    }
}
