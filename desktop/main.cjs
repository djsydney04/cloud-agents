const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateEndpoint, validateRequest } = require("./connection.cjs");
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
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Host returned ${r.status}`);
  }
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
  ipcMain.handle("connect", async (e, c) => {
    trusted(e);
    const endpoint = validateEndpoint(c.endpoint);
    if (
      typeof c.token !== "string" ||
      c.token.length < 32 ||
      c.token.length > 1024
    )
      throw new Error("Invalid host token");
    connection = { endpoint, token: c.token };
    await request("/host");
    if (c.remember) {
      if (
        !safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === "basic_text"
      )
        throw new Error(
          "Secure storage is unavailable. Connect without saving.",
        );
      await fs.writeFile(
        savedPath(),
        JSON.stringify({
          endpoint,
          secret: safeStorage.encryptString(c.token).toString("base64"),
        }),
        { mode: 0o600 },
      );
    } else await fs.rm(savedPath(), { force: true });
    return { endpoint };
  });
  ipcMain.handle("restore", async (e) => {
    trusted(e);
    try {
      const saved = JSON.parse(await fs.readFile(savedPath(), "utf8"));
      connection = {
        endpoint: validateEndpoint(saved.endpoint),
        token: safeStorage.decryptString(Buffer.from(saved.secret, "base64")),
      };
      await request("/host");
      return { endpoint: connection.endpoint };
    } catch {
      connection = null;
      return null;
    }
  });
  ipcMain.handle("disconnect", async (e) => {
    trusted(e);
    connection = null;
    await fs.rm(savedPath(), { force: true });
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
  win.loadFile(path.join(__dirname, "../ui/index.html"));
});
app.on("window-all-closed", () => app.quit());
