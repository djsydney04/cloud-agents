# Verification record

This file distinguishes tested behavior from setup that still needs your machine/account.

## Local evidence — 2026-10-05

- Rust: unit/API tests and warning-free Clippy; locked dependency build.
- Real Docker Desktop ARM64 image build, Codex 0.160.1 and Claude Code 2.1.289 command-line compatibility checked from the installed CLIs.
- Real Docker integration suite: auth and input rejection, missing provider credential rejection, non-root/read-only/capability/resource configuration, FIFO queueing, queued and running cancellation, restart adoption, timeout, logs, workspace archive contents, secret snapshot cleanup, and deletion.
- Native macOS SwiftUI client compiles with Swift 6.
- Electron connection/IPC validation tests pass; npm audit reports zero known vulnerabilities at install time.

## Still requires operator/account verification

- Live paid Codex/Claude inference, subscription login/device flow, credential refresh, and private repository cloning/pushing. Tests deliberately do not copy personal credentials or make paid calls.
- Tailscale across two physical networks, SSH on the target spare machine, startup after reboot, sleep/wake, and real long-running workload behavior.
- Native Intel macOS runtime, Linux desktop secret-store behavior, Apple notarization, VoiceOver, and physical-device accessibility.

The smoke provider is an actual container workload with filesystem/isolation checks, not a simulated AI response. A successful smoke run verifies orchestration, not provider account access.
