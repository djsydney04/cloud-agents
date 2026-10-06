#!/bin/sh
# All platforms build on one personal Mac; Docker supplies Linux toolchains.
set -eu
cd "$(dirname "$0")/.."
rm -rf build/release build/desktop build/linux-desktop
mkdir -p build/release
if ! docker buildx inspect cloud-agents-release >/dev/null 2>&1; then
  docker buildx create --name cloud-agents-release --driver docker-container >/dev/null
fi
sh scripts/bundle-host.sh
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  tar -czf "build/release/cloud-agents-$target.tar.gz" -C "target/$target/release" cloud-agents
done
npx electron-builder --mac --arm64 --x64 --publish never --config.directories.output=build/desktop
cp build/desktop/*.dmg build/release/
docker buildx build --builder cloud-agents-release --platform linux/amd64,linux/arm64 --target host --output type=local,dest=build/linux-host -f scripts/release.Dockerfile .
tar -czf build/release/cloud-agents-x86_64-unknown-linux-gnu.tar.gz -C build/linux-host/linux_amd64 cloud-agents
tar -czf build/release/cloud-agents-aarch64-unknown-linux-gnu.tar.gz -C build/linux-host/linux_arm64 cloud-agents
docker buildx build --builder cloud-agents-release --platform linux/amd64 --target desktop --output type=local,dest=build/linux-desktop -f scripts/release.Dockerfile .
cp build/linux-desktop/*.AppImage build/release/
(cd build/release && shasum -a 256 ./*.tar.gz ./*.dmg ./*.AppImage | sed 's|  ./|  |' > SHA256SUMS)
