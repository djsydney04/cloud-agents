# Build the host and saved deployment image with sh scripts/build-containers.sh cloudflare first.
FROM cloud-agents-host:local AS host
FROM docker:29.6.1-dind@sha256:66d292e5c26bd33a6f6f61cacb880de2186339a524ecba1ce098dbbaceed6515
RUN apk add --no-cache su-exec socat \
    && addgroup -g 1000 agent \
    && adduser -D -u 1000 -G agent -h /home/agent agent
COPY --from=host /usr/local/bin/cloud-agents /usr/local/bin/cloud-agents
COPY build/cloudflare-sandbox.tar /opt/cloud-agents/sandbox.tar
COPY deploy/cloudflare/entrypoint.sh /usr/local/bin/cloudflare-entrypoint
RUN chmod 755 /usr/local/bin/cloudflare-entrypoint
ENV DOCKER_TLS_CERTDIR="" \
    DOCKER_HOST=unix:///var/run/docker.sock \
    HOME=/home/agent \
    CLOUD_AGENTS_HOME=/data \
    CLOUD_AGENTS_DOCKER_NETWORK=host
EXPOSE 7421
ENTRYPOINT ["/usr/local/bin/cloudflare-entrypoint"]
