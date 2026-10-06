## One app. One setup path.

Download Cloud Agents, open it, and choose **This computer → Set up this computer**. The Electron app now includes the Rust host. It prepares the sandbox, chooses an initial CPU/memory budget, installs background startup, and connects without asking you to copy a token. Docker must be installed and running; first setup downloads the tools.

For a headless host, the checksum-verified installer now runs the same `cloud-agents start` command. No source checkout or Rust installation is required. `cloud-agents setup` prepares without installing a service, and `cloud-agents stop` stops automatic host startup while preserving workspaces and containers.

Remote SSH connections, automatic reconnection, resource settings, and the browser workspace remain available. Provider accounts are optional for the real local sandbox check. Choose **Connect an account** to save an API key or Claude token directly on the host; the client does not keep it and the API cannot read it back. ChatGPT subscription sign-in remains a one-time host command documented in the account reference.

The duplicate SwiftUI client and separate Python service installer have been removed. The UI audit is now one Electron accessibility/layout check instead of several overlapping lint stacks, removing 161 development dependencies.

All downloads are built on personal hardware, including Linux binaries and the Linux desktop package built through Docker. Mac preview apps are not Apple-notarized; use Privacy & Security → Open Anyway if macOS blocks the downloaded app.
