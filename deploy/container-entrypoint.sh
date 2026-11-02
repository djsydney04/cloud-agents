#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME"
if [ "${1:-}" = serve ]; then
  # The daemon may still be starting in a Kubernetes sidecar.
  attempts=0
  until docker info >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      printf 'Docker did not become ready; check the socket mount and its group permissions.\n' >&2
      exit 1
    fi
    sleep 1
  done
  image="${CLOUD_AGENTS_IMAGE:-cloud-agents-sandbox:0.1.0}"
  if [ "$image" != cloud-agents-sandbox:0.1.0 ] && ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull "$image"
  fi
  cloud-agents setup
fi
exec cloud-agents "$@"
