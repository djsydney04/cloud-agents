#!/bin/sh
set -eu
mkdir -p /run/sshd /root/.ssh /srv
chmod 700 /root/.ssh
printf '%s\n' "$TEST_PUBLIC_KEY" > /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
ssh-keygen -A
printf 'tunnel-ok\n' > /srv/index.html
python3 -m http.server 7420 --bind 127.0.0.1 --directory /srv >/dev/null 2>&1 &
exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=prohibit-password
