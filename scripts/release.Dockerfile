# Linux artifacts are built by Docker on the personal Mac, not hosted CI.
FROM rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS host-build
WORKDIR /project
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY ui ui
COPY sandbox sandbox
ARG TARGETARCH
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,id=cloud-agents-target-${TARGETARCH},target=/project/target cargo build --release --locked && cp target/release/cloud-agents /cloud-agents
FROM scratch AS host
COPY --from=host-build /cloud-agents /cloud-agents

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS desktop-build
RUN apt-get update && apt-get install -y --no-install-recommends libarchive-tools zip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /project
COPY package.json package-lock.json ./
RUN npm ci
COPY desktop desktop
COPY ui ui
COPY --from=host-build /cloud-agents build/host/cloud-agents
RUN npx electron-builder --linux --x64 --publish never
FROM scratch AS desktop
COPY --from=desktop-build /project/dist/*.AppImage /
