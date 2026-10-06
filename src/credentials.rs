use crate::config::{self, Config};
use anyhow::{Result, bail};
use clap::ValueEnum;
use serde::Deserialize;
use std::fs;

#[derive(Clone, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Credential {
    CodexJson,
    OpenaiKey,
    ClaudeToken,
    AnthropicKey,
    GithubToken,
}
impl Credential {
    fn file(&self) -> &'static str {
        match self {
            Self::CodexJson => "codex.json",
            Self::OpenaiKey => "openai-key",
            Self::ClaudeToken => "claude-token",
            Self::AnthropicKey => "anthropic-key",
            Self::GithubToken => "github-token",
        }
    }
}
/// CLI and UI share validation and storage. Values can be written, never read via API.
pub fn save(c: &Config, kind: &Credential, value: Option<&[u8]>) -> Result<()> {
    let path = c.data_dir.join("credentials").join(kind.file());
    let Some(bytes) = value else {
        if path.exists() {
            fs::remove_file(path)?;
        }
        return Ok(());
    };
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        bail!("Credential must contain 1–1048576 bytes");
    }
    if matches!(kind, Credential::CodexJson) {
        if !serde_json::from_slice::<serde_json::Value>(bytes)?.is_object() {
            bail!("Expected Codex auth JSON object");
        }
        config::private_write(&path, bytes)?;
    } else {
        let text = std::str::from_utf8(bytes)?.trim();
        if text.is_empty() || text.contains(['\n', '\r', '\0']) {
            bail!("Expected a single-line credential");
        }
        config::private_write(&path, text.as_bytes())?;
    }
    Ok(())
}
