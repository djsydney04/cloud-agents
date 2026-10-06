# CI on personal hardware

All workflows use self-hosted runners with the `cloud-agents` label. There is no GitHub-hosted fallback. If the machine is off, asleep, or disconnected, jobs wait for it.

## Trusted execution

This public repository runs Verify only on owner-triggered pushes to `main` or manual runs of `main`. There is no `pull_request` or `pull_request_target` trigger. Release jobs also require the repository owner as actor. GitHub's repository Actions setting must require approval for **all external contributors**; never approve an unreviewed external workflow for this runner. Treat merging code to main as permission to execute it on the machine.

Use a dedicated machine/account for stronger separation from personal files. A runner executes trusted repository code with the privileges of its OS account; containers used by tests do not isolate the runner itself. Checkout does not persist the GitHub job token. Jobs have timeouts and verification/release workflows share a concurrency group.

## Mac prerequisites

- Apple Silicon Mac, logged into a graphical desktop session for Electron.
- Docker Desktop running; Rust stable with rustfmt/clippy, Xcode command-line tools, Python 3, Git, GitHub CLI.
- GitHub runner registered to this repository with labels `self-hosted`, `macOS`, `ARM64`, `cloud-agents`.
- Node 22 is provisioned by the workflow. For local UI checks use Node 22.13+ or 24+.

The runner's macOS login service starts at login, not before login. Docker also needs to start at login. Keep the Mac awake while running jobs. No inbound router port or SSH tunnel is required for GitHub Actions; the runner connects outbound to GitHub.

Follow GitHub's [runner registration](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners) and [service setup](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application). In the runner installation directory:

```sh
./svc.sh status
./svc.sh stop
./svc.sh start
```

## Releases

One job on the personal Mac builds all downloads. macOS host binaries and apps build locally; Docker provides Linux ARM64/x86-64 host toolchains and the Linux x86-64 AppImage build. No additional runner fleet or GitHub-hosted fallback is required. `sh scripts/release.sh` is the same build locally and in CI. Manual runs produce artifacts; only a `v*` tag publishes a release.

The configured Mac runner lives at `~/Library/CloudAgentsCI/runner`. Its user login service starts when you sign in. From that directory use `./svc.sh status`, `./svc.sh stop`, or `./svc.sh start`.
