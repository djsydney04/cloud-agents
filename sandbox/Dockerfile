FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG CODEX_VERSION=0.164.0-alpha.9
ARG CLAUDE_VERSION=2.1.306
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl ripgrep openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && dpkg --compare-versions \
        "$(dpkg-query --show --showformat='${Version}' ca-certificates)" ge '20250419~deb12u2'
COPY entrypoint.sh askpass.sh /opt/cloud-agents/
RUN chmod 755 /opt/cloud-agents/*.sh && mkdir -p /workspace /home/agent && chown 1000:1000 /workspace /home/agent
ENV HOME=/home/agent CODEX_HOME=/home/agent/.codex GIT_TERMINAL_PROMPT=0
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/opt/cloud-agents/entrypoint.sh"]
