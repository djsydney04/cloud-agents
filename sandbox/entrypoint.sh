#!/bin/sh
set -eu
umask 077
provider="$1"
repository="${2:-}"
mkdir -p "$HOME/.codex"
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
