# Troubleshooting

| Symptom | Action |
|---|---|
| Docker unavailable | Start Docker Desktop or the Docker daemon. Run `docker info` as the same ordinary user. |
| Sandbox image missing | From the matching checkout, run `docker build -t cloud-agents-sandbox:0.1.0 sandbox`. |
| A run stays queued | Check Docker/image health, free disk (5 GiB floor by default), and earlier runs consuming budget. FIFO does not skip a large first run. |
| Container exits 137 / memory exceeded | Increase the run's memory, host budget, and Docker Desktop allocation. Leave memory for the OS. |
| Bind mount path missing | Use a local Docker context. Put host data under a directory shared with Docker Desktop. Avoid comma/newline characters in its path. |
| Codex auth expired | Run `cloud-agents login-codex` again. Per-run refreshes do not modify the host's credential source. |
| Claude denied a tool | This version uses `dontAsk` with a coding-tool allowlist. Interactive questions/MCP approvals are not supported. |
| Client cannot reach another Wi-Fi network | Use Tailscale Serve or establish an SSH tunnel to a reachable host. Wi-Fi is not itself NAT traversal. |
| Host works until laptop sleeps | Keep Docker running and prevent sleep while on power; closing a laptop can suspend it. |
| Another host owns state | Stop the other `serve` process or use another data directory and port. Do not delete the lock file to bypass a running host. |
| Token rejected | Retrieve the token from the server's data directory using `cloud-agents token`, not from the client machine. |
| macOS blocks downloaded app | Preview builds are not notarized. Use macOS Privacy & Security → Open Anyway, build with `npm run package:desktop`, or use the browser. |
| Linux secure storage unavailable | Connect without saving or configure your desktop's Secret Service/KWallet backend. |

## Recovery and cleanup

Restarting the Rust service leaves running containers intact and reconciles them on reconnect. A container that was created but never started becomes failed rather than being replayed. Completed output stays in rotated Docker logs; timeout/cancelled output does not survive container removal.

Use the UI to stop and delete individual runs. If the service cannot start, list **only this application's containers** with:

```sh
docker ps -a --filter label=io.cloud-agents.managed=true
```

Inspect a specific container, then use `docker rm -f CONTAINER_NAME` if you intend to stop and remove it. The host will mark a missing active container failed on its next check. Do not prune unrelated Docker resources.

To back up, stop the service and its active jobs, then copy the complete private data directory (including SQLite WAL files if present) to encrypted storage. To rotate the host token, stop the service, replace `token` with at least 32 random characters at file mode 0600, restart, and reconnect clients. Removing provider credentials affects only future runs; revoke compromised credentials with their issuer.

## Updating

Stop the host process, install the next tagged host binary, rebuild the matching sandbox image, then restart. Existing containers retain the image with which they were created. Back up state before upgrading. Release archives include SHA256 checksums; checksum verification checks download integrity, not an independent publisher signature.

### Packaging from an iCloud-synced folder

If Apple signing reports “resource fork, Finder information, or similar detritus,” build outside the synced directory: `npm run package:desktop -- --config.directories.output=/private/tmp/cloud-agents-desktop`. File Provider can recreate Finder metadata while signing. The personal CI runner already builds outside iCloud Documents.
