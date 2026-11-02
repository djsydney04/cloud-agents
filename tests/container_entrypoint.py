#!/usr/bin/env python3
"""Exercise container startup without a Docker daemon or personal state."""
import os
import pathlib
import subprocess
import tempfile

entrypoint = pathlib.Path("deploy/container-entrypoint.sh").resolve()
with tempfile.TemporaryDirectory(prefix="cloud-agents-entrypoint-") as directory:
    root = pathlib.Path(directory)
    commands = root / "bin"
    commands.mkdir()
    for name, source in {
        "docker": '#!/bin/sh\nexit "${DOCKER_FIXTURE_EXIT:-0}"\n',
        "cloud-agents": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\n',
        "sleep": "#!/bin/sh\nexit 0\n",
    }.items():
        path = commands / name
        path.write_text(source)
        path.chmod(0o755)
    log = root / "commands.log"
    env = dict(os.environ, PATH=str(commands) + os.pathsep + os.environ["PATH"],
               HOME=str(root / "home"), FIXTURE_LOG=str(log))
    subprocess.run(["sh", str(entrypoint), "serve"], env=env, check=True)
    assert log.read_text().splitlines() == ["setup", "serve"]
    assert (root / "home").stat().st_mode & 0o777 == 0o700
    log.unlink()
    subprocess.run(["sh", str(entrypoint), "token"], env=env, check=True)
    assert log.read_text().splitlines() == ["token"]
    log.unlink()
    failed = subprocess.run(["sh", str(entrypoint), "serve"],
                            env=dict(env, DOCKER_FIXTURE_EXIT="1"), capture_output=True)
    assert failed.returncode != 0 and b"Docker did not become ready" in failed.stderr
    assert not log.exists(), "An unavailable daemon must not start the host"
print("PASS: container startup, admin commands and bounded daemon readiness")
