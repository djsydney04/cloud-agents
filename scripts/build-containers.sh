#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-local}" in
  local) ;;
  cloudflare) export DOCKER_DEFAULT_PLATFORM=linux/amd64 ;;
  *) printf 'Usage: sh scripts/build-containers.sh [local|cloudflare]\n' >&2; exit 2 ;;
esac
docker build -t cloud-agents-host:local .
docker build -t cloud-agents-sandbox:0.1.0 sandbox
docker build -f sandbox/deploy.Dockerfile -t cloud-agents-deploy:0.1.0 .
if [ "${1:-local}" = cloudflare ]; then
  mkdir -p build
  docker save -o build/cloudflare-sandbox.tar cloud-agents-deploy:0.1.0
fi
