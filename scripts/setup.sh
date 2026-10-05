#!/bin/sh
# Run from a checked-out release. No sudo, credential discovery, or system changes.
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Install and start Docker Desktop (macOS) or Docker Engine (Linux).'; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker is not running or your user cannot access it.'; exit 1; }
command -v cargo >/dev/null || { echo 'Install Rust from https://rustup.rs, then rerun this script.'; exit 1; }
cargo build --release --locked
docker build -t cloud-agents-sandbox:0.1.0 sandbox
install_dir="${CLOUD_AGENTS_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
install -m 755 target/release/cloud-agents "$install_dir/cloud-agents"
"$install_dir/cloud-agents" doctor
printf '\nInstalled %s/cloud-agents\n' "$install_dir"
printf 'Add that directory to PATH, then run:\n  cloud-agents serve\nIn another terminal:\n  cloud-agents token\nOpen http://127.0.0.1:7420 and paste the token.\n'
