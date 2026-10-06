#!/bin/sh
# Contributor setup. End users download the app or use install.sh.
set -eu
cd "$(dirname "$0")/.."
cargo build --locked
exec target/debug/cloud-agents start
