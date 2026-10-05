# cloud agents

Run Codex and Claude Code in isolated workspaces on hardware you own. A small Rust host turns an idle Mac, Mac mini, or Linux machine into a personal agent server. Connect from a native macOS app, Electron app, or browser.

**Personal-host preview.** The host works without a cloud control plane. Provider inference still uses your OpenAI or Anthropic account and network connection. This is an independent project, not an official OpenAI or Anthropic client.

## Try it tonight

On the machine that will run your agents, install and start **Docker Desktop** (Mac) or **Docker Engine** (Linux). Source setup also needs [Rust](https://rustup.rs), Git, and a C compiler. Use an ordinary user with Docker access, not root.

```sh
git clone https://github.com/djsydney04/cloud-agents.git
cd cloud-agents
./scripts/setup.sh
export PATH="$HOME/.local/bin:$PATH"
cloud-agents serve
```

In a second terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
cloud-agents token
```

Open **http://127.0.0.1:7420**, paste that token, and choose **Local sandbox check**. Start the run; it should finish with “Verified” in its output. Export its workspace to find `repo/result.txt`. This check requires no provider account and makes no model calls.

The host defaults to a **4 CPU / 8 GiB aggregate budget**, at most **2 concurrent runs**, and a **5 GiB free-disk admission floor**. Keep those budgets below the resources allocated to Docker, leaving room for your OS. On a smaller host:

```sh
cloud-agents --cpus 2 --memory-mb 4096 --max-jobs 1 serve
```

Options go **before** the subcommand. The host persists its data at `~/.local/share/cloud-agents`; override with `--data-dir /absolute/path` or `CLOUD_AGENTS_HOME`. Run `cloud-agents doctor` to check Docker, disk, image, and provider credential availability.

### Download instead of compiling

[Releases](https://github.com/djsydney04/cloud-agents/releases) contain host archives for Apple Silicon, Intel Mac, Linux x86-64, and Linux ARM64, plus desktop packages. `scripts/install.sh` selects a platform and verifies the downloaded archive against `SHA256SUMS`. It installs into `~/.local/bin`; override with `CLOUD_AGENTS_INSTALL_DIR`.

```sh
./scripts/install.sh
docker build -t cloud-agents-sandbox:0.1.0 sandbox
cloud-agents serve
```

Use the matching release checkout for the sandbox image. Docker is still required on the host. The browser and desktop clients need no Docker or Rust. Desktop packages are ad-hoc signed/unsigned and **not Apple notarized**; use the source builds if your OS blocks a downloaded app. Native macOS requires macOS 14+.

## Connect an agent account

Credentials are configured **on the host**. They are never requested by a desktop client, embedded in an image, or committed to Git. The host connection token is separate from provider credentials.

### Codex with your ChatGPT account

```sh
cloud-agents login-codex
```

This launches an isolated interactive login container. Follow the device-code link. Enable device-code authentication in your ChatGPT security/workspace settings if required. Alternatively import an existing **file-backed** Codex auth cache explicitly:

```sh
cloud-agents credential codex-json < "$HOME/.codex/auth.json"
```

An OS-keychain-only login may not have that file. Each run receives a private copy; token refresh inside a run is not written back to the host. Re-run login if future runs report expired authentication. [Official Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

### API keys or a Claude subscription

For Claude subscriptions, run `claude setup-token` on a machine with Claude Code installed, then import its token on the host. [Official Claude authentication documentation](https://code.claude.com/docs/en/authentication).

```sh
cloud-agents credential claude-token
# Paste the token, press Enter, then Ctrl-D.
```

Other supported credential names are `openai-key`, `anthropic-key`, and `github-token`. The same stdin workflow keeps literal secrets out of shell history. To suppress terminal echo when pasting:

```sh
( trap 'stty echo' EXIT; stty -echo; cloud-agents credential openai-key )
```

API keys take precedence when both an API key and subscription credential are configured. Remove the unused credential to choose subscription billing:

```sh
cloud-agents credential openai-key --remove
```

Credentials are stored as owner-only files under the private host data directory. Use FileVault/LUKS for encryption at rest. Do not back up this directory to public or shared storage.

### GitHub access

Public HTTPS GitHub repositories work immediately. For private repositories, import a narrowly scoped GitHub token:

```sh
cloud-agents credential github-token
```

Use a fine-grained token limited to the repositories you want, with read-only contents unless you want the agent to push. Clone URLs must have the form `https://github.com/owner/repo`; arbitrary hosts, SSH URLs, local paths, and embedded credentials are rejected. Each run clones a fresh shallow checkout and creates `cloud-agents/run`. Nothing is automatically pushed. The agent can push if you give it write-capable credentials and ask it to do so.

## Reach your spare machine

Wi-Fi alone does not make a computer reachable through every router. Keep the machine awake, Docker running, and use one of these private transport options. The Rust service deliberately binds only to loopback.

### SSH: no extra networking service

Enable SSH/Remote Login on the host. From your client machine:

```sh
ssh -N -L 7420:127.0.0.1:7420 your-user@your-host
```

Leave that session open. Connect the app/browser to `http://127.0.0.1:7420` and use the **remote host's** token. Across separate networks, SSH itself needs a reachable address; Tailscale avoids manual router port forwarding.

### Tailscale: across Wi-Fi networks and NAT

Install Tailscale on both machines and sign into your private tailnet. On the host:

```sh
tailscale serve --bg http://127.0.0.1:7420
```

Use the HTTPS URL printed by Tailscale in either desktop client or your browser. Restrict access with your tailnet policy, and retain the host token. This uses **Serve**, not public Funnel. [Tailscale Serve setup](https://tailscale.com/docs/features/tailscale-serve).

On macOS, enable Docker Desktop at login. For a temporary awake session:

```sh
caffeinate -i cloud-agents serve
```

A closed MacBook lid or sleeping machine can still suspend workloads. Keep a spare laptop powered, ventilated, and awake. Model requests need outbound internet access even if clients connect locally.

## Desktop clients

**Native SwiftUI / macOS** — Keychain connection storage, native split view, task submission, output polling, cancellation, export, and deletion:

```sh
./scripts/package-native.sh
open 'dist/Cloud Agents Native.app'
```

**Electron / macOS and Linux** — same workspace as the bundled browser client; sandboxed renderer, no Node integration, narrow IPC, OS-encrypted optional connection storage:

```sh
npm ci
npm run desktop
# Build a distributable:
npm run package:desktop
```

For SSH use `http://127.0.0.1:7420`. Remote addresses must use HTTPS. “Save connection” is optional; browser tokens live only in tab memory and must be pasted again after reload. Linux desktop persistence requires an available OS secret store; plaintext fallback is refused.

## Start automatically

After installing the binary and making it available on PATH:

```sh
python3 scripts/service.py install --cpus 4 --memory-mb 8192 --max-jobs 2
# Remove only the host service:
python3 scripts/service.py remove
```

This installs a per-user LaunchAgent on macOS or a systemd user service on Linux. It does not install Docker or Tailscale. Linux user services run while the user session is active unless an administrator enables lingering (`loginctl enable-linger USER`). macOS services begin at login. Containers survive host-process restarts; the service reconnects to their state. Service logs are in `~/Library/Logs/CloudAgents` or `journalctl --user -u cloud-agents`.

## What the engine guarantees

- SQLite WAL persists run requests and lifecycle transitions. A per-data-directory lock prevents two schedulers.
- FIFO admission reserves per-run CPU/memory and limits concurrency. Requests above configured budgets fail before queueing.
- Each run has its own workspace, prompt input, selected credential snapshot, and container. No Docker socket or host home directory is mounted.
- Containers run as your non-root UID, drop Linux capabilities, use `no-new-privileges`, a read-only image, bounded memory/swap/PIDs and log rotation, and temporary home/cache storage.
- A timeout or cancellation force-removes the run's container. Completed containers retain rotated logs until the run is deleted. Secret snapshots are removed after terminal state.
- Restart reconciliation observes existing containers; it does not silently re-run a half-started task.
- Workspaces persist until explicitly deleted. Export downloads a `.tar.gz` of the completed workspace, including its `.git` directory.

**Boundaries:** single trusted owner per host, not hostile multi-tenant hosting. Agent processes can read their own injected credentials and access outbound internet/LAN. Docker is a practical isolation boundary, not a VM-grade guarantee against malicious kernel exploits. Use scoped credentials and a dedicated machine/VM for untrusted repositories. Disk admission is a free-space threshold, **not a hard per-run disk quota**; active jobs can fill disk. Timeouts require a responsive Docker daemon and running host scheduler. Output can contain sensitive information printed by the agent; arbitrary secret redaction is not guaranteed. Rust makes resource/state handling explicit; it does not make model output deterministic.

## Development and verification

```sh
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
docker build -t cloud-agents-sandbox:0.1.0 sandbox
python3 tests/integration.py
npm ci && npm run test:desktop
swift build --package-path native  # macOS
```

The integration test uses temporary state and real containers: authentication rejection, unsafe URL rejection, credential gating, resource flags, queue admission, queued/running cancellation, host restart, timeout, output, workspace export, and cleanup. No paid model calls or personal credentials are used. See [verification notes](docs/verification.md), [architecture](docs/architecture.md), [API](docs/api.md), and [troubleshooting](docs/troubleshooting.md).

Current scope: independent task runs, one connected host at a time, raw provider event output. Interactive approval prompts, conversational resume, fleet-wide scheduling, egress allowlists, hard disk quotas, Windows hosts, and signed/notarized app distribution are not implemented.

MIT licensed.
