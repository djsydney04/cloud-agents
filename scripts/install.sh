#!/bin/sh
# Downloads a release binary and checks its published checksum. Review before running.
set -eu
version="${CLOUD_AGENTS_VERSION:-0.1.0}"
case "$version" in *[!0-9.]*|'') echo 'Expected a numeric release version.' >&2; exit 1;; esac
case "$(uname -s)-$(uname -m)" in
 Darwin-arm64) target=aarch64-apple-darwin;;
 Darwin-x86_64) target=x86_64-apple-darwin;;
 Linux-x86_64) target=x86_64-unknown-linux-gnu;;
 Linux-aarch64) target=aarch64-unknown-linux-gnu;;
 *) echo 'Unsupported platform. Build from source instead.' >&2; exit 1;;
esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
asset="cloud-agents-${target}.tar.gz"
base="https://github.com/djsydney04/cloud-agents/releases/download/v${version}"
curl --fail --location --proto '=https' --tlsv1.2 "$base/$asset" -o "$scratch/$asset"
curl --fail --location --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$scratch/SHA256SUMS"
# Verify only the selected asset, and fail if its checksum entry is absent.
awk -v asset="$asset" '$2 == asset {print; found=1} END {if (!found) exit 1}' "$scratch/SHA256SUMS" > "$scratch/selected.sha256"
(cd "$scratch" && if command -v sha256sum >/dev/null; then sha256sum -c selected.sha256; else shasum -a 256 -c selected.sha256; fi)
tar -xzf "$scratch/$asset" -C "$scratch" cloud-agents
install_dir="${CLOUD_AGENTS_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
install -m 755 "$scratch/cloud-agents" "$install_dir/cloud-agents"
printf 'Installed %s/cloud-agents. Add this directory to PATH.\n' "$install_dir"
printf 'Next: build the sandbox image from the matching release checkout; see README.\n'
