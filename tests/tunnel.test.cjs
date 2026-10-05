const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Tunnel, validateSSH, sshArgs } = require("../desktop/tunnel.cjs");
const config = {
  host: "mini.local",
  user: "alice",
  port: 22,
  remotePort: 7420,
  identityFile: "/tmp/key with spaces",
};
test("SSH arguments preserve boundaries and require verified host identity", () => {
  for (const host of [
    "-oProxyCommand=evil",
    "host;touch /tmp/x",
    "a\nb",
    "user@host",
  ])
    assert.throws(() => validateSSH({ ...config, host }));
  assert.throws(() => validateSSH({ ...config, port: 65536 }));
  const args = sshArgs(validateSSH(config), 17420);
  assert(args.includes("StrictHostKeyChecking=yes"));
  assert(args.includes("BatchMode=yes"));
  assert(args.includes("127.0.0.1:17420:127.0.0.1:7420"));
  assert(args.includes("/tmp/key with spaces"));
  assert.equal(args.at(-1), "alice@mini.local");
});
test("lost SSH connection retries, recovers, and explicit stop cancels stale retries", async () => {
  const children = [],
    pending = [];
  const spawnProcess = () => {
    const p = new EventEmitter();
    p.stderr = new EventEmitter();
    p.exitCode = null;
    p.kill = () => {
      p.exitCode = 0;
      queueMicrotask(() => p.emit("exit", 0));
    };
    children.push(p);
    return p;
  };
  const tunnel = new Tunnel({
    spawnProcess,
    choosePort: async () => 17420,
    delay: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clearDelay: (t) => {
      t.cancelled = true;
    },
  });
  await tunnel.start(config);
  assert.equal(children.length, 1);
  tunnel.markReady();
  assert.equal(tunnel.status().state, "connected");
  children[0].stderr.emit("data", Buffer.from("connection lost"));
  children[0].exitCode = 255;
  children[0].emit("exit", 255);
  assert.equal(tunnel.status().state, "reconnecting");
  assert.equal(pending[0].ms, 1000);
  pending[0].fn();
  assert.equal(children.length, 2);
  tunnel.markReady();
  assert.equal(tunnel.status().error, "");
  await tunnel.stop();
  assert.equal(tunnel.status().state, "off");
  pending[0].fn();
  assert.equal(children.length, 2);
});
