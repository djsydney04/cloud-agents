const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs");
const run = promisify(execFile);

function hostBinary(resourcesPath, packaged) {
  const binary = packaged
    ? path.join(resourcesPath, "host", "cloud-agents")
    : path.join(__dirname, "../target/debug/cloud-agents");
  if (!fs.existsSync(binary))
    throw new Error(
      "The host is missing. Developers: run cargo build before npm run desktop.",
    );
  return binary;
}
async function startLocalHost(binary) {
  try {
    await run(binary, ["start", "--no-open"], {
      timeout: 15 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const { stdout } = await run(binary, ["token"], { timeout: 10000 });
    return {
      endpoint: `http://${process.env.CLOUD_AGENTS_BIND || "127.0.0.1:7420"}`,
      token: stdout.trim(),
    };
  } catch (error) {
    // Setup logs contain progress and diagnostics, never provider credentials.
    throw new Error((error.stderr || error.message).trim().slice(-2000));
  }
}
module.exports = { hostBinary, startLocalHost };
