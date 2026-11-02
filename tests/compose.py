#!/usr/bin/env python3
"""Check exported initial budgets survive the actual Compose interpolation."""
import json
import os
import shlex
import subprocess

command = shlex.split(os.environ.get("COMPOSE_COMMAND", "docker compose"))
budgets = {
    "CLOUD_AGENTS_CPUS": "1", "CLOUD_AGENTS_MEMORY_MB": "1024",
    "CLOUD_AGENTS_MAX_JOBS": "1", "CLOUD_AGENTS_MIN_FREE_GB": "0",
}
env = dict(os.environ, CLOUD_AGENTS_DATA_DIR="/tmp/cloud-agents-test-state", DOCKER_GID="1000", **budgets)
result = subprocess.run([*command, "config", "--format", "json"], env=env, check=True, text=True, capture_output=True)
host = json.loads(result.stdout)["services"]["host"]
for key, expected in budgets.items():
    assert host["environment"].get(key) == expected, key
print("PASS: Compose preserves exported resource budgets")
