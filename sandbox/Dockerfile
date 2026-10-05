FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG CODEX_VERSION=0.160.1
ARG CLAUDE_VERSION=2.1.289
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl ripgrep openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION}
COPY entrypoint.sh askpass.sh /opt/cloud-agents/
RUN chmod 755 /opt/cloud-agents/*.sh && mkdir -p /workspace /home/agent && chown 1000:1000 /workspace /home/agent
ENV HOME=/home/agent CODEX_HOME=/home/agent/.codex GIT_TERMINAL_PROMPT=0
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/opt/cloud-agents/entrypoint.sh"]
