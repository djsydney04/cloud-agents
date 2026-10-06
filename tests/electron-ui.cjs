// Rendered UI lint in the actual Electron shell with its real preload/IPC.
// Only the host API is a local fixture; no provider account or Docker is used.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
for (const dir of ["desktop", "ui"]) {
  for (const file of readdirSync(dir).filter((file) => /\.c?js$/.test(file)))
    execFileSync(process.execPath, ["--check", `${dir}/${file}`]);
}
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { _electron: electron } = require("playwright");
const axe = require("axe-core");

(async () => {
  const output = path.resolve("test-results/electron-ui");
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-agents-ui-"));
  const token = "ui-lint-fixture-token-not-a-real-secret";
  let offline = false;
  const settings = {
    cpus: 4,
    memory_mb: 8192,
    max_jobs: 2,
    min_free_gb: 5,
    paused: false,
    revision: 0,
  };
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "smoke",
    prompt:
      "Inspect a long task title and its readable output on a compact desktop window",
    status: "succeeded",
    cpus: 1,
    memory_mb: 256,
    created_at: 1700000000,
    repository: null,
    error: null,
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end('{"error":"Fixture token required"}');
      return;
    }
    if (offline) {
      res.writeHead(503);
      res.end('{"error":"Host temporarily unavailable"}');
      return;
    }
    if (req.url === "/api/credentials" && req.method === "PUT") {
      res.writeHead(204);
      res.end();
      return;
    }
    const host = {
      ...settings,
      name: "UI lint host",
      version: "fixture",
      used_cpus: 0,
      used_memory_mb: 0,
      credentials: {},
      health: {
        docker_ready: true,
        image_ready: true,
        docker_cpus: 8,
        docker_memory_mb: 16384,
      },
    };
    if (req.url === "/api/settings" && req.method === "PUT") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      Object.assign(settings, JSON.parse(raw), {
        revision: settings.revision + 1,
      });
    }
    const bodies = {
      "/api/host": host,
      "/api/jobs": [job],
      "/api/settings": settings,
      [`/api/jobs/${job.id}/logs`]: {
        output: "Verified sandbox fixture\n" + "A long output line ".repeat(60),
      },
    };
    if (!(req.url in bodies)) {
      res.writeHead(404);
      res.end('{"error":"Unexpected fixture route"}');
      return;
    }
    res.end(JSON.stringify(bodies[req.url]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let app, page;
  const report = { states: [], errors: [] };
  const watchdog = setTimeout(() => {
    console.error("Electron UI lint timed out");
    app?.process().kill("SIGKILL");
    process.exitCode = 1;
  }, 120000);
  try {
    app = await electron.launch({
      args: [path.resolve("desktop/main.cjs")],
      env: { ...process.env, CLOUD_AGENTS_PROFILE: profile },
      chromiumSandbox: true,
      timeout: 30000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.waitForSelector("#settings[open]");
    assert.equal(
      await page.evaluate(() => typeof window.cloudAgents?.request),
      "function",
      "Real Electron preload must be loaded",
    );
    const preferences = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    );
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.sandbox, true);
    await page.evaluate(axe.source);
    async function audit(name) {
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      const result = await page.evaluate(async () =>
        window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: [
              "wcag2a",
              "wcag2aa",
              "wcag21a",
              "wcag21aa",
              "best-practice",
            ],
          },
        }),
      );
      const overflow = await page.evaluate(() => {
        const roots = [
          document.documentElement,
          ...document.querySelectorAll("dialog[open]"),
        ];
        return roots
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.id || el.tagName);
      });
      const state = {
        name,
        violations: result.violations,
        incomplete: result.incomplete,
        overflow,
      };
      report.states.push(state);
      await page.screenshot({
        path: path.join(output, `${name}.png`),
        fullPage: false,
      });
      console.log(
        `${name}: ${state.violations.length} accessibility violations, ${overflow.length} horizontal overflows`,
      );
    }
    for (const [width, height] of [
      [1240, 840],
      [680, 560],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(...size),
        [width, height],
      );
      await page.waitForFunction((w) => innerWidth === w, width);
      await page.locator("#transport").selectOption("local");
      await audit(`${width}-local-setup`);
      await page.locator("#transport").selectOption("ssh");
      await audit(`${width}-ssh-connection`);
      await page.locator("#ssh-fields summary").click();
      await audit(`${width}-ssh-options`);
      await page.locator("#ssh-fields summary").click();
      await page.locator("#transport").selectOption("direct");
      await audit(`${width}-direct-connection`);
    }
    await page
      .locator("#endpoint")
      .fill(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#token").fill(token);
    await page.locator("#remember").uncheck();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.getElementById("connection-status").textContent ===
        "Host connected",
    );
    for (const [width, height] of [
      [1240, 840],
      [680, 560],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(...size),
        [width, height],
      );
      await page.waitForFunction((w) => innerWidth === w, width);
      await page.locator("#new-run").click();
      await audit(`${width}-composer`);
      await page.locator("#account-choice").click();
      await audit(`${width}-accounts`);
      await page.keyboard.press("Escape");
      await page.locator("#run-form summary").click();
      await audit(`${width}-run-limits`);
      await page.locator("#run-form summary").click();
      await page.locator("#host-settings-button").click();
      await page.waitForFunction(
        () => document.getElementById("budget-cpus").value === "4",
      );
      await audit(`${width}-host-settings`);
      await page.locator("#budget-paused").check();
      await page.locator("#save-host-settings").click();
      await page.waitForFunction(() =>
        document
          .getElementById("settings-result")
          .textContent.startsWith("Saved on host"),
      );
      await audit(`${width}-settings-saved`);
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .locator("#host-settings-button")
          .evaluate((el) => el === document.activeElement),
        true,
        "Dialog restores keyboard focus",
      );
      await page.locator(".run-item").click();
      await page.waitForFunction(() =>
        document.getElementById("output").textContent.includes("Verified"),
      );
      await audit(`${width}-run-output`);
    }
    offline = true;
    await page.waitForFunction(() =>
      document
        .getElementById("connection-status")
        .textContent.includes("Reconnecting"),
    );
    await audit("680-reconnecting");
    assert.equal(await page.locator("#submit").isDisabled(), true);
    offline = false;
    await page.waitForFunction(
      () =>
        document.getElementById("connection-status").textContent ===
        "Host connected",
    );
    await audit("680-recovered");
    const failed = report.states.filter(
      (s) => s.violations.length || s.overflow.length,
    );
    assert.deepEqual(report.errors, [], "Renderer must not throw");
    assert.equal(
      failed.length,
      0,
      JSON.stringify(
        failed.map((s) => ({
          name: s.name,
          violations: s.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target),
          })),
          overflow: s.overflow,
        })),
        null,
        2,
      ),
    );
    console.log(
      `PASS: ${report.states.length} Electron UI states, accessibility, layout, recovery, focus and isolated preload`,
    );
  } catch (error) {
    report.errors.push(error.stack);
    if (page)
      await page
        .screenshot({ path: path.join(output, "failure.png") })
        .catch(() => {});
    throw error;
  } finally {
    clearTimeout(watchdog);
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
