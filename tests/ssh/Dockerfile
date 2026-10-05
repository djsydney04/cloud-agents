FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server python3 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*
COPY start.sh /start.sh
ENTRYPOINT ["sh", "/start.sh"]
