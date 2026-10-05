use crate::config::Config;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// Persistent admission policy. Updating it never resizes a running container.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub cpus: u32,
    pub memory_mb: u32,
    pub max_jobs: usize,
    pub min_free_gb: u64,
    pub paused: bool,
    pub revision: u64,
}
impl Settings {
    pub fn from_config(c: &Config) -> Self {
        Self {
            cpus: c.cpus,
            memory_mb: c.memory_mb,
            max_jobs: c.max_jobs,
            min_free_gb: c.min_free_gb,
            paused: false,
            revision: 0,
        }
    }
    pub fn validate(&self) -> Result<()> {
        if !(1..=1024).contains(&self.cpus)
            || !(256..=16_777_216).contains(&self.memory_mb)
            || !(1..=1024).contains(&self.max_jobs)
            || self.min_free_gb > 1_000_000
            || self.revision == u64::MAX
        {
            bail!("Invalid host resource limits");
        }
        Ok(())
    }
}
