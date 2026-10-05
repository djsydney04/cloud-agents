const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateEndpoint, validateRequest } = require("./connection.cjs");
const { Tunnel, validateSSH } = require("./tunnel.cjs");
const tunnel = new Tunnel();
let configurationTask = Promise.resolve();
function configureSerially(action) {
  configurationTask = configurationTask.catch(() => {}).then(action);
  return configurationTask;
}
let quitting = false,
  tray;
let connection = null,
  win;
const savedPath = () => path.join(app.getPath("userData"), "connection.json");
function trusted(event) {
  if (
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame
  )
    throw new Error("Untrusted sender");
}
async function request(route, method = "GET", body) {
  if (!connection) throw new Error("Connect to a host first.");
  const r = await fetch(connection.endpoint + "/api" + route, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Host returned ${r.status}`);
  }
  tunnel.markReady();
  return r;
}
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 680,
    minHeight: 560,
    backgroundColor: "#111211",
    title: "Cloud Agents",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  async function configure(c) {
    const ssh = c.mode === "ssh" ? validateSSH(c.ssh) : null;
    const direct = ssh ? null : validateEndpoint(c.endpoint);
    if (
      typeof c.token !== "string" ||
      c.token.length < 32 ||
      c.token.length > 1024
    )
      throw new Error("Invalid host token");
    if (
      c.remember &&
      (!safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === "basic_text")
    )
      throw new Error(
        "Secure storage unavailable. Uncheck Save connection to connect without saving.",
      );
    const endpoint = ssh
      ? await tunnel.start(ssh)
      : (await tunnel.stop(), direct);
    connection = {
      endpoint,
      token: c.token,
      mode: ssh ? "ssh" : "direct",
      ssh,
    };
    if (c.remember) {
      await fs.writeFile(
        savedPath(),
        JSON.stringify({
          mode: connection.mode,
          endpoint: direct,
          ssh,
          secret: safeStorage.encryptString(c.token).toString("base64"),
        }),
        { mode: 0o600 },
      );
    } else await fs.rm(savedPath(), { force: true });
    // Keep a configured connection even if the machine is asleep. Renderer retries reads.
    return { endpoint, mode: connection.mode, ssh };
  }
  ipcMain.handle("connect", async (e, c) => {
    trusted(e);
    return configureSerially(() => configure(c));
  });
  ipcMain.handle("restore", async (e) => {
    trusted(e);
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(savedPath(), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const token = safeStorage.decryptString(
      Buffer.from(saved.secret, "base64"),
    );
    return configureSerially(() =>
      configure({ ...saved, token, remember: true }),
    );
  });
  ipcMain.handle("status", async (e) => {
    trusted(e);
    return connection?.mode === "ssh"
      ? tunnel.status()
      : { state: connection ? "direct" : "off", error: "" };
  });
  ipcMain.handle("disconnect", async (e) => {
    trusted(e);
    return configureSerially(async () => {
      connection = null;
      await tunnel.stop();
      await fs.rm(savedPath(), { force: true });
    });
  });
  ipcMain.handle("request", async (e, r) => {
    trusted(e);
    validateRequest(r);
    const response = await request(r.path, r.method, r.body);
    return response.status === 204 ? null : response.json();
  });
  ipcMain.handle("export", async (e, id) => {
    trusted(e);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run");
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: `cloud-agents-${id}.tar.gz`,
    });
    if (canceled) return;
    const res = await request(`/jobs/${id}/archive`);
    const { pipeline } = require("node:stream/promises");
    const { Readable } = require("node:stream");
    await pipeline(
      Readable.fromWeb(res.body),
      require("node:fs").createWriteStream(filePath, { mode: 0o600 }),
    );
  });
  // Closing the window keeps SSH alive. Quit explicitly from the tray or app menu.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR4nGNgGAUo4Ni7Vf9BeBgZNHAGUF0jTBwZk2Uw2QYMcwAAxUZQuUMTn7oAAAAASUVORK5CYII=",
  );
  tray = new Tray(icon);
  tray.setToolTip("Cloud Agents — connection stays active");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Cloud Agents", click: () => win.show() },
      { label: "Quit and stop tunnel", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => win.show());
  app.on("activate", () => win.show());
  win.loadFile(path.join(__dirname, "../ui/index.html"));
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  tunnel.stop().finally(() => app.quit());
});
