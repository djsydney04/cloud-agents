#!/bin/sh
# One Rust host travels inside the desktop app. Mac host is universal.
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/host
if [ "$(uname -s)" = Darwin ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  cargo build --release --locked --target aarch64-apple-darwin
  cargo build --release --locked --target x86_64-apple-darwin
  lipo -create target/aarch64-apple-darwin/release/cloud-agents target/x86_64-apple-darwin/release/cloud-agents -output build/host/cloud-agents
else
  cargo build --release --locked
  cp target/release/cloud-agents build/host/cloud-agents
fi
