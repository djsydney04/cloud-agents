# Verification record

This file distinguishes tested behavior from setup that still needs your machine/account.

## Historical v0.1 evidence — 2026-10-05

- Rust: unit/API tests and warning-free Clippy; locked dependency build.
- Real Docker Desktop ARM64 image build, Codex 0.160.1 and Claude Code 2.1.289 command-line compatibility checked from the installed CLIs.
- Real Docker integration suite: auth and input rejection, missing provider credential rejection, non-root/read-only/capability/resource configuration, FIFO queueing, queued and running cancellation, restart adoption, timeout, logs, workspace archive contents, secret snapshot cleanup, and deletion.
- Native macOS SwiftUI client compiles with Swift 6; universal Apple Silicon + Intel application builds pass in GitHub Actions. The native app connected without saving credentials, submitted a real sandbox check, and displayed successful output.
- Electron connection/IPC validation tests pass; npm audit reports zero known vulnerabilities at install time. The packaged Electron app connected to the real test host, submitted a smoke job, and displayed its successful output.
- Browser workspace: connection, task submission, completion/output, desktop and 390 px layout inspected.
- Hosted Ubuntu x86-64 Docker integration and macOS client/package CI passed: [Verify run](https://github.com/djsydney04/cloud-agents/actions/runs/37386549714).

- All four host release builds (macOS ARM64/x86-64 and Linux ARM64/x86-64), native universal macOS packaging, Electron macOS ARM64/x86-64 DMGs, and Linux AppImage builds passed in the [v0.1.0 release workflow](https://github.com/djsydney04/cloud-agents/actions/runs/37388813183).

## Still requires operator/account verification

- Live paid Codex/Claude inference, subscription login/device flow, credential refresh, and private repository cloning/pushing. Tests deliberately do not copy personal credentials or make paid calls.
- Tailscale across two physical networks, SSH on the target spare machine, startup after reboot, sleep/wake, and real long-running workload behavior.
- Native Intel macOS runtime, Linux desktop secret-store behavior, Apple notarization, VoiceOver, and physical-device accessibility.

The smoke provider is an actual container workload with filesystem/isolation checks, not a simulated AI response. A successful smoke run verifies orchestration, not provider account access.

## v0.2.0 connection and settings verification

- Rust/API and desktop validation/lifecycle tests pass; native SwiftUI build passes.
- Real SSH fixture verifies forwarding, reconnection after killing the SSH child, refusal of an unknown host key, and socket cleanup on explicit stop. A separate compiled Swift harness verifies native SSH forwarding, connection replacement, and cleanup against the same fixture.
- Real Docker host tests verify live settings, persistence across restart, queue pause/resume, optimistic-revision conflict handling, and rejection of budgets above observed VM capacity.
- Per-host SSH key provisioning, an actual Wi-Fi outage/sleep cycle, and unattended operation across your own two machines still need operator verification. No personal SSH keys or provider credentials are used by the tests.

- Packaged Electron saved-profile recovery passed with the host offline across a client quit/relaunch, then a host restart. Live 2-CPU/4-GiB settings and paused queue persisted; the host settings dialog was exercised in the browser.

## v0.3 simplified setup

- One production client: Electron with a bundled Rust host; the shared browser UI remains available.
- `tests/setup.py` verifies embedded sandbox provisioning, adaptive defaults, private settings, and repeat setup preserving user settings.
- `tests/local-setup.cjs` verifies fresh-profile one-click setup against a real per-user service and Docker workload, account-key save/remove, a profile containing only `mode: local`, and reconnection after quitting/relaunching.
- The Electron UI audit covers 22 states at normal and minimum window sizes, including local onboarding and account setup, with zero automatic accessibility violations or horizontal overflows in the local run.
- Authenticated write-only account configuration, private file permissions, and rejected unauthenticated writes are covered by Rust API tests. No personal provider credentials or paid inference are used.
- Mac notarization, subscription/device-code login with a real account, physical two-machine networking, and Linux systemd service runtime remain operator verification boundaries.

- The packaged macOS Electron app passed the same fresh-profile local-setup, account save/remove, real sandbox, and relaunch test using its bundled universal Rust executable.
- Browser startup from the installer token fragment was exercised against a real host; the UI authenticated and immediately removed the fragment from the URL.
