/* Real SSH forwarding, host-key enforcement, recovery, and child cleanup. */
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Tunnel } = require("../desktop/tunnel.cjs");
const dir = mkdtempSync(path.join(tmpdir(), "cloud-agents-ssh-"));
const name = "cloud-agents-ssh-test-" + process.pid;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, seconds = 30) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* Best effort: fixture startup or cleanup may race process exit. */
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for real SSH tunnel");
}
(async () => {
  let tunnel;
  try {
    const key = path.join(dir, "key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--memory",
      "256m",
      "--cpus",
      "1",
      "-p",
      "127.0.0.1::22",
      "-e",
      "TEST_PUBLIC_KEY=" + readFileSync(key + ".pub", "utf8").trim(),
      "cloud-agents-ssh-test",
    );
    const port = Number(docker("port", name, "22/tcp").split(":").at(-1));
    const hostKey = await wait(() =>
      docker("exec", name, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"),
    );
    const hosts = path.join(dir, "known_hosts");
    writeFileSync(hosts, `[127.0.0.1]:${port} ${hostKey}\n`);
    const config = {
      host: "127.0.0.1",
      user: "root",
      port,
      remotePort: 7420,
      identityFile: key,
    };
    tunnel = new Tunnel({ knownHostsFile: hosts });
    const endpoint = await tunnel.start(config);
    const read = async () => {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
      return (await r.text()).trim() === "tunnel-ok";
    };
    await wait(read);
    tunnel.markReady();
    const old = tunnel.child;
    old.kill("SIGKILL");
    await wait(() => tunnel.child && tunnel.child !== old);
    await wait(read);
    tunnel.markReady();
    await tunnel.stop();
    assert.equal(tunnel.status().state, "off");
    await assert.rejects(() =>
      fetch(endpoint, { signal: AbortSignal.timeout(1000) }),
    );

    // An untrusted server must not get an automatic TOFU exception.
    writeFileSync(hosts, "");
    await tunnel.start(config);
    await wait(() =>
      /Host key verification failed|No .* host key is known/.test(
        tunnel.status().error,
      ),
    );
    await tunnel.stop();
    console.log(
      "PASS: real SSH tunnel, request forwarding, process-loss recovery, strict host-key rejection, explicit-stop cleanup",
    );
  } finally {
    if (tunnel) await tunnel.stop();
    try {
      docker("rm", "-f", name);
    } catch {
      /* Best effort: fixture startup or cleanup may race process exit. */
    }
    rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
