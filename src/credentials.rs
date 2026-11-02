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
    CloudflareApiToken,
    CloudflareAccountId,
    GoogleCredentialsJson,
    Kubeconfig,
    SshKey,
    SshKnownHosts,
    DeploymentEnv,
}

pub const DEPLOYMENT_FILES: [&str; 7] = [
    "cloudflare-api-token",
    "cloudflare-account-id",
    "google-credentials.json",
    "kubeconfig",
    "ssh-key",
    "ssh-known-hosts",
    "deployment-env.json",
];

impl Credential {
    pub(crate) fn file(&self) -> &'static str {
        match self {
            Self::CodexJson => "codex.json",
            Self::OpenaiKey => "openai-key",
            Self::ClaudeToken => "claude-token",
            Self::AnthropicKey => "anthropic-key",
            Self::GithubToken => "github-token",
            Self::CloudflareApiToken => "cloudflare-api-token",
            Self::CloudflareAccountId => "cloudflare-account-id",
            Self::GoogleCredentialsJson => "google-credentials.json",
            Self::Kubeconfig => "kubeconfig",
            Self::SshKey => "ssh-key",
            Self::SshKnownHosts => "ssh-known-hosts",
            Self::DeploymentEnv => "deployment-env.json",
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
    config::private_write(&path, validate(kind, bytes)?)?;
    Ok(())
}

fn validate<'a>(kind: &Credential, bytes: &'a [u8]) -> Result<&'a [u8]> {
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        bail!("Credential must contain 1–1048576 bytes");
    }
    match kind {
        Credential::CodexJson | Credential::GoogleCredentialsJson | Credential::DeploymentEnv => {
            let value: serde_json::Value = serde_json::from_slice(bytes)?;
            let Some(object) = value.as_object() else {
                bail!("Expected a credential JSON object");
            };
            if matches!(kind, Credential::DeploymentEnv) {
                for (key, value) in object {
                    if !matches!(
                        key.as_str(),
                        "HTTP_PROXY"
                            | "HTTPS_PROXY"
                            | "ALL_PROXY"
                            | "NO_PROXY"
                            | "http_proxy"
                            | "https_proxy"
                            | "all_proxy"
                            | "no_proxy"
                    ) || !value
                        .as_str()
                        .is_some_and(|s| !s.contains(['\0', '\r', '\n']))
                    {
                        bail!(
                            "Deployment environment supports only single-line proxy strings: HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY, or their lowercase forms"
                        );
                    }
                }
            }
            Ok(bytes)
        }
        Credential::Kubeconfig | Credential::SshKey | Credential::SshKnownHosts => {
            let text = std::str::from_utf8(bytes)?;
            if text.trim().is_empty() || text.contains('\0') {
                bail!("Expected a nonempty UTF-8 credential file without NUL bytes");
            }
            Ok(bytes)
        }
        _ => {
            let text = std::str::from_utf8(bytes)?.trim();
            if text.is_empty() || text.contains(['\n', '\r', '\0']) {
                bail!("Expected a single-line credential");
            }
            Ok(text.as_bytes())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::os::unix::fs::PermissionsExt;

    #[derive(Parser)]
    struct Opt {
        #[command(flatten)]
        config: Config,
    }

    #[test]
    fn credential_files_preserve_multiline_content_and_remain_private() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = Opt::parse_from(["test", "--data-dir", tmp.path().to_str().unwrap()]).config;
        c.init().unwrap();
        let content =
            b"-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n";
        for kind in [
            Credential::SshKey,
            Credential::SshKnownHosts,
            Credential::Kubeconfig,
        ] {
            save(&c, &kind, Some(content)).unwrap();
            let path = c.data_dir.join("credentials").join(kind.file());
            assert_eq!(fs::read(&path).unwrap(), content);
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            save(&c, &kind, None).unwrap();
            assert!(!path.exists());
        }
        assert!(validate(&Credential::SshKey, b"private\0key").is_err());
        assert!(validate(&Credential::Kubeconfig, b" \n").is_err());
    }

    #[test]
    fn token_and_json_validation_reject_invalid_values() {
        assert_eq!(
            validate(&Credential::CloudflareApiToken, b" token\n").unwrap(),
            b"token"
        );
        assert!(validate(&Credential::CloudflareAccountId, b"one\ntwo").is_err());
        assert!(validate(&Credential::GoogleCredentialsJson, b"[]").is_err());
        assert!(validate(&Credential::GoogleCredentialsJson, b"not JSON").is_err());
        assert!(
            validate(
                &Credential::GoogleCredentialsJson,
                br#"{"type":"external_account"}"#
            )
            .is_ok()
        );
        assert!(validate(&Credential::CodexJson, b"null").is_err());
    }

    #[test]
    fn deployment_environment_only_accepts_proxy_string_values() {
        assert!(
            validate(
                &Credential::DeploymentEnv,
                br#"{"HTTPS_PROXY":"http://proxy:8080","no_proxy":"localhost,127.0.0.1"}"#
            )
            .is_ok()
        );
        for bytes in [
            br#"{"PATH":"/malicious"}"#.as_slice(),
            br#"{"HTTPS_PROXY":false}"#.as_slice(),
            br#"{"ALL_PROXY":"proxy\u0000suffix"}"#.as_slice(),
            br#"{"HTTP_PROXY":"proxy\nother"}"#.as_slice(),
            b"[]".as_slice(),
        ] {
            assert!(validate(&Credential::DeploymentEnv, bytes).is_err());
        }
    }
}
