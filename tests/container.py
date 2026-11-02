#!/usr/bin/env python3
"""Real containerized-host smoke test. Requires local Docker and built sandbox."""
import json
import os
import pathlib
import platform
import stat
import subprocess
import tempfile
import time
import uuid


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, text=True, capture_output=True)


docker("build", "-t", "cloud-agents-host:local", ".")
context = json.loads(docker("context", "inspect").stdout)[0]
endpoint = os.environ.get("DOCKER_HOST", context["Endpoints"]["docker"]["Host"])
assert endpoint.startswith("unix://"), "This test requires a local Unix-socket Docker daemon"
socket = pathlib.Path(endpoint.removeprefix("unix://")).resolve()
assert stat.S_ISSOCK(socket.stat().st_mode)
# Desktop's API socket on macOS is a client socket; mount the VM daemon socket.
socket_source = "/var/run/docker.sock" if platform.system() == "Darwin" else str(socket)
socket_group = 0 if platform.system() == "Darwin" else socket.stat().st_gid
name = "cloud-agents-host-test-" + uuid.uuid4().hex[:12]
with tempfile.TemporaryDirectory(prefix="cloud-agents-container-") as directory:
    state = pathlib.Path(directory).resolve()
    try:
        docker("run", "-d", "--name", name, "--read-only", "--cap-drop=ALL",
               "--security-opt=no-new-privileges", "--user", f"{os.getuid()}:{os.getgid()}",
               "--group-add", str(socket_group), "--tmpfs", "/tmp:mode=1777",
               "--mount", f"type=bind,src={state},dst=/data",
               "--mount", f"type=bind,src={socket_source},dst=/var/run/docker.sock",
               "-e", f"CLOUD_AGENTS_DOCKER_DATA_DIR={state}",
               "-e", "CLOUD_AGENTS_CPUS=1", "-e", "CLOUD_AGENTS_MEMORY_MB=1024",
               "-e", "CLOUD_AGENTS_MAX_JOBS=1", "-e", "CLOUD_AGENTS_MIN_FREE_GB=0",
               "cloud-agents-host:local")
        deadline = time.monotonic() + 90
        while docker("exec", name, "cloud-agents", "doctor", check=False).returncode:
            assert time.monotonic() < deadline, docker("logs", name).stdout
            time.sleep(1)
        token = docker("exec", name, "cloud-agents", "token").stdout.strip()
        def get(path):
            return docker("exec", name, "wget", "-qO-",
                          "--header", "Authorization: Bearer " + token,
                          "http://127.0.0.1:7420" + path, check=False)

        while get("/api/host").returncode:
            assert time.monotonic() < deadline, docker("logs", name).stdout
            time.sleep(1)
        request = json.loads(docker("exec", name, "cloud-agents", "smoke").stdout)
        identifier = request["id"]
        deadline = time.monotonic() + 60
        while True:
            result = get(f"/api/jobs/{identifier}")
            assert result.returncode == 0, result.stderr
            job = json.loads(result.stdout)
            if job["status"] in ("succeeded", "failed", "cancelled"):
                assert job["status"] == "succeeded", job
                break
            assert time.monotonic() < deadline, job
            time.sleep(1)
        assert (state / "jobs" / identifier / "workspace" / "repo" / "result.txt").exists()
        daemon_job = "cloud-agents-" + identifier
        details = json.loads(docker("inspect", daemon_job).stdout)[0]
        assert details["Config"]["User"] == f"{os.getuid()}:{os.getgid()}"
        assert details["HostConfig"]["ReadonlyRootfs"]
        assert not any(m["Destination"].endswith("docker.sock") for m in details["Mounts"])
        docker("stop", "--time", "10", name)
        assert docker("inspect", "-f", "{{.State.ExitCode}}", name).stdout.strip() == "0"
        docker("start", name)
        deadline = time.monotonic() + 30
        while get("/api/host").returncode:
            assert time.monotonic() < deadline
            time.sleep(1)
        assert docker("exec", name, "cloud-agents", "token").stdout.strip() == token
        assert json.loads(get(f"/api/jobs/{identifier}").stdout)["status"] == "succeeded"
        print("PASS: containerized host, daemon mount mapping, real smoke job and restart")
    finally:
        docker("rm", "-f", name, check=False)
        # Includes a job that failed before the local identifier was assigned.
        containers = docker("ps", "-aq", "--filter", "label=io.cloud-agents.managed=true").stdout.split()
        for container in containers:
            mounts = json.loads(docker("inspect", container).stdout)[0]["Mounts"]
            if any(m["Source"].startswith(str(state) + "/") for m in mounts):
                docker("rm", "-f", container, check=False)
