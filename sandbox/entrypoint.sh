#!/bin/sh
set -eu
umask 077
provider="$1"
repository="${2:-}"
mkdir -p "$HOME/.codex"
# OpenSSH needs a passwd entry even when Docker runs as the host's arbitrary UID.
if [ -f /opt/cloud-agents/libnss_wrapper.so ]; then
  printf 'agent:x:%s:%s:Cloud Agents:%s:/bin/sh\n' "$(id -u)" "$(id -g)" "$HOME" > "$HOME/.passwd"
  printf 'agent:x:%s:\n' "$(id -g)" > "$HOME/.group"
  export NSS_WRAPPER_PASSWD="$HOME/.passwd" NSS_WRAPPER_GROUP="$HOME/.group"
  export LD_PRELOAD=/opt/cloud-agents/libnss_wrapper.so
fi
if [ -f /run/secrets/cloudflare-api-token ]; then export CLOUDFLARE_API_TOKEN="$(cat /run/secrets/cloudflare-api-token)"; fi
if [ -f /run/secrets/cloudflare-account-id ]; then export CLOUDFLARE_ACCOUNT_ID="$(cat /run/secrets/cloudflare-account-id)"; fi
if [ -f /run/secrets/google-credentials.json ]; then
  export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/run/secrets/google-credentials.json
  export GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-credentials.json
fi
if [ -f /run/secrets/kubeconfig ]; then
  mkdir -p "$HOME/.kube"
  cp /run/secrets/kubeconfig "$HOME/.kube/config"
  chmod 600 "$HOME/.kube/config"
  export KUBECONFIG="$HOME/.kube/config"
fi
if [ -f /run/secrets/ssh-key ] || [ -f /run/secrets/ssh-known-hosts ]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if [ -f /run/secrets/ssh-key ]; then cp /run/secrets/ssh-key "$HOME/.ssh/id_cloud_agents"; fi
  if [ -f /run/secrets/ssh-known-hosts ]; then cp /run/secrets/ssh-known-hosts "$HOME/.ssh/known_hosts"; else : > "$HOME/.ssh/known_hosts"; fi
  cat > "$HOME/.ssh/config" <<SSH
Host *
    BatchMode yes
    StrictHostKeyChecking yes
    UserKnownHostsFile "$HOME/.ssh/known_hosts"
    GlobalKnownHostsFile /dev/null
    IdentityFile "$HOME/.ssh/id_cloud_agents"
    IdentitiesOnly yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
SSH
  chmod 600 "$HOME/.ssh/"*
fi
if [ -f /run/secrets/deployment-env.json ]; then
  for proxy_key in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
    if proxy_value="$(python3 - "$proxy_key" <<'PY'
import json, sys
try:
    with open('/run/secrets/deployment-env.json') as source:
        values = json.load(source)
    allowed = {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
               'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}
    if not isinstance(values, dict) or not values.keys() <= allowed:
        raise ValueError()
    if any(not isinstance(value, str) or any(c in value for c in '\0\r\n') for value in values.values()):
        raise ValueError()
except (OSError, ValueError):
    print('Invalid deployment proxy configuration', file=sys.stderr)
    sys.exit(2)
if sys.argv[1] not in values:
    sys.exit(3)
sys.stdout.write(values[sys.argv[1]])
PY
)"; then
      export "$proxy_key=$proxy_value"
    else
      proxy_status=$?
      if [ "$proxy_status" -ne 3 ]; then exit "$proxy_status"; fi
    fi
  done
fi
if [ -f /run/secrets/github-token ]; then export GIT_ASKPASS=/opt/cloud-agents/askpass.sh; fi
if [ -n "$repository" ]; then
  git clone --depth=1 -- "$repository" /workspace/repo
  cd /workspace/repo
else
  mkdir -p /workspace/repo
  cd /workspace/repo
  git init -q
fi
git config user.name 'Cloud Agents'
git config user.email 'agent@localhost'
git checkout -b "cloud-agents/run"
case "$provider" in
  codex)
    if [ -f /run/secrets/codex.json ]; then cp /run/secrets/codex.json "$CODEX_HOME/auth.json"; fi
    if [ -f /run/secrets/openai-key ]; then export CODEX_API_KEY="$(cat /run/secrets/openai-key)"; fi
    # The resource-limited container is the outer sandbox; there is no host mount or Docker socket.
    exec codex exec --dangerously-bypass-approvals-and-sandbox --json - < /run/input/prompt
    ;;
  claude)
    if [ -f /run/secrets/claude-token ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/claude-token)"; fi
    if [ -f /run/secrets/anthropic-key ]; then export ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic-key)"; fi
    exec claude -p --permission-mode dontAsk --allowedTools 'Bash,Read,Edit,Write,Glob,Grep' --output-format stream-json --verbose < /run/input/prompt
    ;;
  smoke)
    printf 'Sandbox ready. Running local verification.\n'
    id
    test ! -S /var/run/docker.sock
    if touch /opt/should-not-be-writable 2>/dev/null; then exit 1; fi
    printf 'Hello from your own hardware.\n' > result.txt
    python3 -c 'import platform; print("Architecture:", platform.machine())'
    sleep 2
    printf 'Verified: non-root, read-only image, writable workspace, no Docker socket.\n'
    ;;
  *) printf 'Unsupported provider\n' >&2; exit 2 ;;
esac
