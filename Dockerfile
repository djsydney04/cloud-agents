# syntax=docker/dockerfile:1
FROM rust:1.94-alpine3.23@sha256:77237dd363a0b127bb5ef532c2d64c0deb380b738e43a9c4bdac73398d6d0a08 AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY ui ui
COPY sandbox sandbox
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --locked && cp target/release/cloud-agents /cloud-agents

FROM docker:29.6.1-cli@sha256:862099ada15c669000bef53aa4cb9d821262829f45b0dda2159ccb276443043b
RUN apk add --no-cache tini \
    && addgroup -g 1000 agent && adduser -D -u 1000 -G agent agent \
    && mkdir /data && chown agent:agent /data
COPY --from=build /cloud-agents /usr/local/bin/cloud-agents
COPY deploy/container-entrypoint.sh /opt/cloud-agents/container-entrypoint.sh
RUN chmod 755 /opt/cloud-agents/container-entrypoint.sh
ENV CLOUD_AGENTS_HOME=/data HOME=/tmp/cloud-agents-home
USER 1000:1000
WORKDIR /data
ENTRYPOINT ["/sbin/tini", "--", "/opt/cloud-agents/container-entrypoint.sh"]
CMD ["serve"]
