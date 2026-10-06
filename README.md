# cloud agents

Run coding agents on a computer you own. One Rust host, one desktop app.

## Get started

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. [Download Cloud Agents](https://github.com/djsydney04/cloud-agents/releases/latest) for your computer and open it.
3. Choose **This computer → Set up this computer**.

The app includes the host, prepares its workspace, chooses a resource budget, and starts it in the background. First setup downloads the agent tools and takes a few minutes. No Git checkout, Rust installation, terminal commands, or token copying is needed for local desktop setup.

Choose **Local sandbox check** to try a real run without an AI account. When ready, choose **Connect an account** to save an API key or Claude token on the host. [Subscription sign-in and remote setup](docs/accounts-and-remote.md) cover the alternatives. Provider inference uses your account and internet connection.

Preview Mac downloads are not notarized. If macOS blocks the app, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it. Linux desktop downloads are x86-64 AppImages; the headless host also supports ARM64.

## A spare Mac or Linux server

Install Docker first, then run this on the machine that will host your agents:

```sh
curl -fsSL https://raw.githubusercontent.com/djsydney04/cloud-agents/main/scripts/install.sh | sh
```

The installer checks the release checksum, installs the host, prepares its workspace, enables startup at login, and opens the browser already connected. On a headless server, prefix the installer shell with `CLOUD_AGENTS_NO_OPEN=1`. Linux needs a user systemd session; automatic startup before login requires your system administrator to enable lingering.

On your main computer, choose **Another computer · SSH** in Cloud Agents. [Remote setup](docs/accounts-and-remote.md#reach-your-spare-machine) covers SSH keys and reaching a machine across different networks. A remote host must be awake and reachable; Wi-Fi alone does not bypass a router.

## Everyday controls

- **New run:** choose Codex, Claude, or the local sandbox check.
- **Host settings:** change CPU, memory, concurrent runs, and pause/resume remotely.
- **Connection:** switch machines. Saved connections reconnect automatically.
- Closing the app window leaves the connection in the tray. Quitting stops its tunnel; the host service keeps running.

Resource settings allocate agent capacity within Docker. They do not resize the underlying VM. To stop the host's background service, run `~/.local/bin/cloud-agents stop`; existing workspaces and containers are preserved. On an app-only installation, the host binary is under `~/.local/share/cloud-agents/bin/`.

## Development

Node 22+, Rust, and Docker are needed only to develop the app:

```sh
cargo build --locked
npm ci
npm run desktop
```

```sh
cargo test --locked
npm run check:ui
npm run test:desktop
```

`check:ui` runs formatting, JavaScript syntax checks, and the actual Electron accessibility/layout audit. Reports and screenshots appear in `test-results/electron-ui/`. The audit uses a disposable profile and local host fixture, with no personal credentials or model calls. Automated accessibility checks supplement manual keyboard and screen-reader review.

`npm run package:desktop` bundles the Rust host inside the app. [Architecture](docs/architecture.md), [API](docs/api.md), [troubleshooting](docs/troubleshooting.md), and [personal-hardware CI](docs/personal-ci.md) cover advanced details. There is no second native client or separate service installer.
