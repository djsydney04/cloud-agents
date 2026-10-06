// End-to-end local onboarding: real host service + Docker, no accounts or paid calls.
const { _electron: electron } = require("playwright");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createServer } = require("node:net");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const run = promisify(execFile);
(async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cloud-agents-onboarding-"),
  );
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const env = {
    ...process.env,
    CLOUD_AGENTS_HOME: path.join(root, "host"),
    CLOUD_AGENTS_BIND: `127.0.0.1:${port}`,
    CLOUD_AGENTS_PROFILE: path.join(root, "profile"),
  };
  const binary = path.resolve("target/debug/cloud-agents");
  let app;
  const launch = () =>
    electron.launch({
      args: process.env.CLOUD_AGENTS_PACKAGED_APP
        ? []
        : [path.resolve("desktop/main.cjs")],
      executablePath: process.env.CLOUD_AGENTS_PACKAGED_APP || undefined,
      env,
      chromiumSandbox: true,
    });
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.setDefaultTimeout(120000);
    await page.waitForSelector("#settings[open]");
    assert.equal(await page.locator("#transport").inputValue(), "local");
    await page
      .getByRole("button", { name: "Set up this computer", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.getElementById("connection-status").textContent ===
        "Host connected",
      null,
      { timeout: 120000 },
    );
    const saved = JSON.parse(
      await readFile(path.join(root, "profile/connection.json"), "utf8"),
    );
    assert.deepEqual(
      saved,
      { mode: "local" },
      "Local profile stores no host token",
    );
    await page.locator("#account-choice").click();
    await page.locator("#credential-value").fill("fixture-not-a-real-api-key");
    await page.locator("#save-credential").click();
    await page.waitForFunction(() =>
      document
        .getElementById("credential-result")
        .textContent.startsWith("Saved on host"),
    );
    assert.equal(
      await readFile(path.join(root, "host/credentials/openai-key"), "utf8"),
      "fixture-not-a-real-api-key",
    );
    assert.equal(await page.locator("#credential-value").inputValue(), "");
    await page.locator("#remove-credential").click();
    await page.waitForFunction(() =>
      document
        .getElementById("credential-result")
        .textContent.startsWith("Removed from host"),
    );
    await assert.rejects(
      readFile(path.join(root, "host/credentials/openai-key")),
      { code: "ENOENT" },
    );
    await page.keyboard.press("Escape");
    await page.locator("#smoke-choice").click();
    await page.locator("#submit").click();
    await page.waitForFunction(
      () => document.getElementById("run-state").textContent === "succeeded",
      null,
      { timeout: 90000 },
    );
    await page.waitForFunction(() =>
      document.getElementById("output").textContent.includes("Verified"),
    );
    const text = await page.locator("#output").textContent();
    assert.match(text, /Verified/);
    await app.close();
    app = null;
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(
      () =>
        document.getElementById("connection-status").textContent ===
        "Host connected",
      null,
      { timeout: 30000 },
    );
    assert.equal(
      await page.locator("#settings").isVisible(),
      false,
      "Saved local mode restores automatically",
    );
    const token = (
      await readFile(path.join(root, "host/token"), "utf8")
    ).trim();
    const host = await (
      await fetch(`http://127.0.0.1:${port}/api/host`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const browserWindow = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      return window.loadURL(url);
    }, `http://127.0.0.1:${port}/#token=${token}`);
    const browser = await browserWindow;
    await browser.waitForFunction(
      () =>
        document.getElementById("connection-status").textContent ===
        "Host connected",
    );
    assert.equal(
      new URL(browser.url()).hash,
      "",
      "Browser startup removes its token fragment from history",
    );
    await browser.close();
    assert(
      host.cpus <= host.health.docker_cpus &&
        host.memory_mb <= host.health.docker_memory_mb,
    );
    console.log(
      "PASS: fresh-profile one-click setup, real background service, adaptive resources, real Docker run, token-free profile and relaunch",
    );
  } finally {
    if (app) await app.close();
    await run(binary, ["stop"], { env }).catch((error) =>
      console.error("Cleanup:", error.stderr),
    );
    // Remove only containers carrying IDs recorded in this disposable host database.
    const jobsRoot = path.join(root, "host/jobs");
    const { readdir } = require("node:fs/promises");
    for (const id of await readdir(jobsRoot).catch(() => [])) {
      if (/^[a-f0-9-]{36}$/.test(id))
        await run("docker", ["rm", "-f", `cloud-agents-${id}`]).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
