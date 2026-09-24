"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, session, systemPreferences } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pagePath = path.join(__dirname, "..", "index.html");
const pageUrl = pathToFileURL(pagePath).href;
let mainWindow;
let saveInProgress = false;

function isAppUrl(url) {
  return typeof url === "string" && url.split("#")[0] === pageUrl;
}

function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
    throw new Error("Untrusted application frame");
  }
}

async function microphonePermission() {
  if (process.platform !== "darwin" || app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "声线采样室",
    width: 1240,
    height: 900,
    minWidth: 800,
    minHeight: 640,
    backgroundColor: "#f2eddf",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  const win = mainWindow;
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["返回录音", "退出并丢弃"],
      defaultId: 0,
      cancelId: 0,
      message: "录音还保存在当前窗口中",
      detail: "退出会丢失本次录音。请先导出需要保留的 WAV 和 JSON 文件。",
      noLink: true
    });
    if (choice === 1) event.preventDefault();
  });
  win.on("close", (event) => {
    if (saveInProgress) {
      event.preventDefault();
      dialog.showMessageBoxSync(win, { message: "文件正在保存，请完成保存后再退出。" });
    }
  });
  win.on("closed", () => { mainWindow = null; });
  win.loadFile(pagePath).catch((error) => {
    dialog.showErrorBox("应用加载失败", error.message);
    app.exit(1);
  });
}

app.whenReady().then(() => {
  const localSession = session.defaultSession;
  // The application is offline; block accidental external resource requests.
  localSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  localSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === mainWindow?.webContents && isAppUrl(contents.getURL()) &&
    permission === "media" && details.mediaType === "audio");
  localSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === mainWindow?.webContents && isAppUrl(contents.getURL()) &&
      isAppUrl(details.requestingUrl) && permission === "media" &&
      details.mediaTypes?.length > 0 && details.mediaTypes.every((type) => type === "audio"));
  });

  ipcMain.handle("voice:microphone", async (event) => {
    assertSender(event);
    return microphonePermission();
  });
  ipcMain.handle("voice:save", async (event, payload) => {
    assertSender(event);
    if (saveInProgress) return { status: "error", message: "另一个文件正在保存，请稍后重试。" };
    const { filename, bytes } = payload || {};
    if (typeof filename !== "string" || !/^OWNER_[a-zA-Z0-9_.-]+\.(wav|json)$/.test(filename) ||
        !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 * 1024) {
      return { status: "error", message: "导出文件内容无效。" };
    }
    saveInProgress = true;
    try {
      const extension = path.extname(filename).slice(1);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "保存录音文件",
        defaultPath: path.join(app.getPath("documents"), filename),
        filters: [{ name: extension === "wav" ? "WAV 音频" : "JSON 质量清单", extensions: [extension] }],
        properties: ["createDirectory", "showOverwriteConfirmation"]
      });
      if (result.canceled || !result.filePath) return { status: "cancelled" };
      await fs.writeFile(result.filePath, bytes);
      return { status: "saved", filename: path.basename(result.filePath) };
    } catch (error) {
      console.error("File save failed:", error.code || error.name);
      return { status: "error", message: "保存失败，请检查磁盘空间和文件夹权限后重试。" };
    } finally {
      saveInProgress = false;
    }
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: "声线采样室", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { label: "文件", submenu: [{ role: "close" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "显示", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }] }
  ]));
  createWindow();
  app.on("activate", () => { if (!mainWindow) createWindow(); });
}).catch((error) => {
  dialog.showErrorBox("应用启动失败", error.message);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
