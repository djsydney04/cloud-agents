const { spawn } = require("node:child_process");
const net = require("node:net");

function validateSSH(input) {
  const c = {
    host: input.host,
    user: input.user,
    port: Number(input.port || 22),
    remotePort: Number(input.remotePort || 7420),
    identityFile: input.identityFile || "",
  };
  if (
    typeof c.host !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.host) ||
    typeof c.user !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(c.user)
  )
    throw new Error("Enter a hostname/IP and SSH username (IPv4 or DNS).");
  if (
    ![c.port, c.remotePort].every(
      (p) => Number.isInteger(p) && p >= 1 && p <= 65535,
    )
  )
    throw new Error("Ports must be between 1 and 65535.");
  if (
    typeof c.identityFile !== "string" ||
    c.identityFile.length > 4096 ||
    (c.identityFile &&
      (!c.identityFile.startsWith("/") || /[\r\n\0]/.test(c.identityFile)))
  )
    throw new Error("SSH key path must be an absolute file path.");
  return c;
}
function sshArgs(c, localPort, knownHostsFile) {
  const args = [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-p",
    String(c.port),
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${c.remotePort}`,
  ];
  if (c.identityFile) args.push("-i", c.identityFile);
  if (knownHostsFile) args.push("-o", `UserKnownHostsFile=${knownHostsFile}`);
  args.push(`${c.user}@${c.host}`);
  return args;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
class Tunnel {
  constructor({
    spawnProcess = spawn,
    choosePort = freePort,
    delay = setTimeout,
    clearDelay = clearTimeout,
    knownHostsFile,
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.choosePort = choosePort;
    this.delay = delay;
    this.clearDelay = clearDelay;
    this.knownHostsFile = knownHostsFile;
    this.state = "off";
    this.generation = 0;
    this.attempt = 0;
    this.lastError = "";
  }
  async start(input) {
    const c = validateSSH(input);
    await this.stop();
    this.config = c;
    const generation = this.generation;
    this.localPort = await this.choosePort();
    if (generation !== this.generation) throw new Error("Connection cancelled");
    this.endpoint = `http://127.0.0.1:${this.localPort}`;
    this.attempt = 0;
    this.lastError = "";
    this.launch(this.generation);
    return this.endpoint;
  }
  launch(generation) {
    if (generation !== this.generation) return;
    this.state = "connecting";
    const child = this.spawnProcess(
      "ssh",
      sshArgs(this.config, this.localPort, this.knownHostsFile),
      { stdio: ["ignore", "ignore", "pipe"], shell: false },
    );
    this.child = child;
    let error = "";
    const started = Date.now();
    child.stderr.on("data", (d) => {
      error = (error + d.toString()).slice(-2000);
    });
    let handled = false;
    const exited = () => {
      if (handled) return;
      handled = true;
      if (this.child === child) this.child = null;
      if (generation !== this.generation) return;
      this.lastError =
        error.trim() || "SSH disconnected. Retrying automatically.";
      this.state = "reconnecting";
      if (Date.now() - started > 60000) this.attempt = 0;
      const wait = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
      this.timer = this.delay(() => this.launch(generation), wait);
    };
    child.once("error", (e) => {
      error = e.message;
      exited();
    });
    child.once("exit", exited);
  }
  markReady() {
    if (this.child) {
      this.state = "connected";
      this.lastError = "";
      this.attempt = 0;
    }
  }
  status() {
    return { state: this.state, error: this.lastError };
  }
  async stop() {
    this.generation++;
    if (this.timer) this.clearDelay(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    this.state = "off";
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
  }
}
module.exports = { Tunnel, validateSSH, sshArgs };
