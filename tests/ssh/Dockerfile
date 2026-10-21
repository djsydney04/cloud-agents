FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server python3 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*
COPY start.sh /start.sh
ENTRYPOINT ["sh", "/start.sh"]
