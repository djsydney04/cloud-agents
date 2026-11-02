#!/bin/sh
set -eu

# The Worker and host independently enforce the same token. Never print it.
case "${CLOUD_AGENTS_TOKEN:-}" in
  *[!a-f0-9]*|'') echo 'A lowercase hex CLOUD_AGENTS_TOKEN secret is required' >&2; exit 1 ;;
esac
[ "${#CLOUD_AGENTS_TOKEN}" -eq 64 ] || { echo 'CLOUD_AGENTS_TOKEN must contain 64 hex characters' >&2; exit 1; }
install -d -m 700 -o 1000 -g 1000 /data
umask 077
printf '%s' "$CLOUD_AGENTS_TOKEN" > /data/token
chown 1000:1000 /data/token
unset CLOUD_AGENTS_TOKEN

dockerd_pid=
host_pid=
proxy_pid=
shutdown() {
  trap '' TERM INT
  trap - EXIT
  [ -z "$proxy_pid" ] || kill -TERM "$proxy_pid" 2>/dev/null || true
  [ -z "$host_pid" ] || kill -TERM "$host_pid" 2>/dev/null || true
  [ -z "$dockerd_pid" ] || kill -TERM "$dockerd_pid" 2>/dev/null || true
  wait || true
}
trap 'shutdown; exit 0' TERM INT
trap shutdown EXIT

# Cloudflare supports rootful DinD with network rule manipulation disabled.
# Agent job runs and setup builds must also use Docker's host network.
dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock \
  --iptables=false --ip6tables=false --ip-forward=false --group=agent &
dockerd_pid=$!
attempt=0
until docker info >/dev/null 2>&1; do
  kill -0 "$dockerd_pid" 2>/dev/null || { echo 'Docker exited during startup' >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 120 ] || { echo 'Docker did not become ready within 60 seconds' >&2; exit 1; }
  sleep 0.5
done
docker load --input /opt/cloud-agents/sandbox.tar >/dev/null

su-exec agent /usr/local/bin/cloud-agents \
  --bind 127.0.0.1:7420 --image cloud-agents-deploy:0.1.0 \
  --cpus 1 --memory-mb 2048 --max-jobs 1 --min-free-gb 1 serve &
host_pid=$!
socat TCP-LISTEN:7421,reuseaddr,fork TCP:127.0.0.1:7420 &
proxy_pid=$!

# Fail the outer container if any required process dies. PID 1 owns cleanup.
while kill -0 "$dockerd_pid" 2>/dev/null \
    && kill -0 "$host_pid" 2>/dev/null \
    && kill -0 "$proxy_pid" 2>/dev/null; do
  sleep 1 &
  wait $! || true
done
echo 'A required host process exited' >&2
exit 1
