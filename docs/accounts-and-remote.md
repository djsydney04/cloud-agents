# Accounts, remote connections, and resource limits

## Connect an agent account

Choose **Connect an account** in the app to send an API key, Claude subscription token, or GitHub token through the private connection and save it only on the host. The desktop app does not retain provider credentials, and the API cannot read them back. The host connection token is separate. The commands below are alternatives for subscription sign-in or headless administration.

On an app-only installation, first add the managed host to your shell path:

```sh
export PATH="$HOME/.local/share/cloud-agents/bin:$HOME/.local/bin:$PATH"
```

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

### Persistent SSH tunnel in the desktop app

In the desktop app, open **Connection & credentials → SSH tunnel**. Enter the machine name/IP, SSH username, and the host connection token. Click **Connect**. The app opens a private local forward automatically; no forwarding command or terminal window needs to stay open.

- **Save connection** remembers the profile and encrypts the host token using the OS credential store. A saved connection reconnects when the app starts, even if the host was offline at startup.
- SSH keepalives detect dead connections; retries back off from 1 to 30 seconds. The UI shows **Reconnecting** and disables new submissions until the host responds again. Task submissions are never replayed automatically.
- In Electron, closing the window leaves the app and tunnel running in the menu bar/system tray. Choose **Quit and stop tunnel** to stop it.
- The app use your installed OpenSSH client and existing SSH keys/agent. Optional key-path, SSH-port, and remote-service-port fields are under **SSH options**. Password prompts are not supported in an unattended tunnel.

One-time SSH setup on your client (enable SSH / Remote Login on the host first):

```sh
ssh your-user@your-host
# Verify the displayed fingerprint against your host, then exit.
ssh -o BatchMode=yes your-user@your-host true
# This should succeed without a password prompt before using the app.
```

If it asks for a password, configure an SSH key/agent first. Keep private keys on the client; the app never copies them to the host or stores their contents. It refuses unknown/changed host keys rather than silently trusting a different machine. DNS names, IPv4 addresses, and standard SSH configuration work; raw IPv6 addresses are not supported in this preview's SSH form.

Across separate networks, SSH itself needs a reachable address. Use a Tailscale hostname/IP to reach a machine behind NAT, or select **Direct / Tailscale** with the private HTTPS URL below.

The browser cannot start SSH processes. Use the desktop app or, for a manual browser tunnel:

```sh
ssh -N -L 7420:127.0.0.1:7420 your-user@your-host
```

### Tailscale: across Wi-Fi networks and NAT

Install Tailscale on both machines and sign into your private tailnet. On the host:

```sh
tailscale serve --bg http://127.0.0.1:7420
```

Use the HTTPS URL printed by Tailscale in the desktop app or your browser. Restrict access with your tailnet policy, and retain the host token. This uses **Serve**, not public Funnel. [Tailscale Serve setup](https://tailscale.com/docs/features/tailscale-serve).

On macOS, enable Docker Desktop at login. For a temporary awake session:

```sh
caffeinate -i cloud-agents serve
```

A closed MacBook lid or sleeping machine can still suspend workloads. Keep a spare laptop powered, ventilated, and awake. Model requests need outbound internet access even if clients connect locally.

## Change host / VM resource settings

Open **Host settings** from the desktop app or the browser. Set the total **CPU budget**, **memory budget**, **concurrent runs**, and **free disk reserve**, then choose **Save settings**. **Pause new runs** stops admissions while allowing existing work to finish.

The screen shows what the Docker daemon offers and what your runs currently use. Updates take effect without restarting the host and persist in its private `settings.json`. On subsequent launches, saved settings take precedence over the initial CLI budget flags. To return to CLI defaults, stop the host and move `settings.json` aside before restarting.

A reduction that would undercut running work or strand a queued run is rejected with an explanation. New runs use the updated budget; existing containers keep their original per-run limits. Concurrent editors receive a conflict rather than overwriting each other's changes.

These controls allocate **agent capacity within the VM/host**. They do not resize a cloud provider's VM or change Docker Desktop's VM allocation. To grant more than Docker currently offers, resize that underlying VM first, then raise the budget here. Disk reserve remains an admission threshold, not a per-run disk quota.
