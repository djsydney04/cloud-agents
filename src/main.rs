mod api;
mod config;
mod engine;
mod model;
mod store;
use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use config::Config;
use std::{fs, io::Read};

#[derive(Parser)]
#[command(version, about = "Your hardware. Your agent workspace.")]
struct Cli {
    #[command(flatten)]
    config: Config,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    /// Start the host and serve the workspace on localhost:7420.
    Serve,
    /// Check Docker, sandbox image, disk capacity and credential availability.
    Doctor,
    /// Print the private host connection token (never share publicly).
    Token,
    /// Import a credential from stdin, without putting it in shell history.
    Credential {
        #[arg(value_enum)]
        kind: Credential,
        #[arg(long)]
        remove: bool,
    },
    /// Sign in to Codex inside a disposable container using a device code.
    LoginCodex,
    /// Submit a local smoke run; requires a running host.
    Smoke,
}
#[derive(Clone, ValueEnum)]
enum Credential {
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
#[tokio::main]
async fn main() -> Result<()> {
    let mut cli = Cli::parse();
    cli.config.init()?;
    match cli.command {
        Commands::Token => println!("{}", fs::read_to_string(cli.config.data_dir.join("token"))?),
        Commands::Credential { kind, remove } => {
            let path = cli.config.data_dir.join("credentials").join(kind.file());
            if remove {
                if path.exists() {
                    fs::remove_file(path)?;
                }
                println!(
                    "Credential removed; existing runs retain their snapshot until completion."
                );
            } else {
                let mut bytes = Vec::new();
                std::io::stdin()
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() > 1024 * 1024 || bytes.is_empty() {
                    bail!("Credential must contain 1–1048576 bytes");
                }
                if matches!(kind, Credential::CodexJson) {
                    let v: serde_json::Value = serde_json::from_slice(&bytes)?;
                    if !v.is_object() {
                        bail!("Expected Codex auth JSON object");
                    }
                } else {
                    let text = std::str::from_utf8(&bytes)?.trim();
                    if text.is_empty() || text.contains(['\n', '\r', '\0']) {
                        bail!("Expected a single-line credential");
                    }
                    bytes = text.as_bytes().to_vec();
                }
                config::private_write(&path, &bytes)?;
                println!("Credential saved privately on this host.");
            }
        }
        Commands::LoginCodex => {
            // A dedicated directory contains only login state, never the user's own Codex home.
            let login = cli.config.data_dir.join("login-codex");
            config::private_dir(&login)?;
            let (uid, gid) = config::identity();
            let user = format!("{uid}:{gid}");
            let status = tokio::process::Command::new("docker")
                .args([
                    "run",
                    "--rm",
                    "-it",
                    "--user",
                    &user,
                    "--cap-drop=ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--mount",
                ])
                .arg(format!(
                    "type=bind,src={},dst=/home/agent/.codex",
                    login.display()
                ))
                .args([
                    "--entrypoint",
                    "codex",
                    &cli.config.image,
                    "-c",
                    "cli_auth_credentials_store=\"file\"",
                    "login",
                    "--device-auth",
                ])
                .status()
                .await?;
            if !status.success() {
                bail!("Codex login did not complete");
            }
            let bytes =
                fs::read(login.join("auth.json")).context("Codex did not write auth.json")?;
            config::private_write(&cli.config.data_dir.join("credentials/codex.json"), &bytes)?;
            fs::remove_dir_all(login)?;
            println!("Codex login saved. You can now submit Codex runs.");
        }
        Commands::Doctor => {
            let e = engine::Engine::new(cli.config)?;
            let result = e.check_health().await;
            println!(
                "{}",
                serde_json::to_string_pretty(&*e.health.lock().unwrap())?
            );
            println!(
                "Codex credentials: {}\nClaude credentials: {}",
                e.has_credential(&model::Provider::Codex),
                e.has_credential(&model::Provider::Claude)
            );
            result?;
            if !e.health.lock().unwrap().image_ready {
                bail!("Build the sandbox: docker build -t cloud-agents-sandbox:0.1.0 sandbox");
            }
        }
        Commands::Smoke => {
            let token = fs::read_to_string(cli.config.data_dir.join("token"))?;
            let response=reqwest::Client::new().post(format!("http://{}/api/jobs",cli.config.bind)).bearer_auth(token.trim()).json(&serde_json::json!({"provider":"smoke","prompt":"Verify sandbox","memory_mb":256})).send().await?;
            let status = response.status();
            let body = response.text().await?;
            if !status.is_success() {
                bail!("{status}: {body}");
            }
            println!("{body}");
        }
        Commands::Serve => {
            let lock = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(cli.config.data_dir.join("host.lock"))?;
            fs2::FileExt::try_lock_exclusive(&lock)
                .context("Another cloud-agents host is using this data directory")?;
            let bind = cli.config.bind;
            let e = engine::Engine::new(cli.config)?;
            // One scheduler owns admission. API cancellation is persisted and observed next tick.
            let scheduler = e.clone();
            let task = tokio::spawn(async move {
                loop {
                    if let Err(err) = scheduler.tick().await {
                        eprintln!("Host check: {err}");
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });
            let listener = tokio::net::TcpListener::bind(bind).await?;
            println!(
                "Cloud Agents: http://{bind}\nRun `cloud-agents token` to connect. Containers survive host restarts."
            );
            axum::serve(listener, api::router(e))
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
            task.abort();
            drop(lock);
        }
    }
    Ok(())
}
