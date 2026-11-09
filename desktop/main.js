"use strict";
// Desktop shell: starts the Python chat server, opens it in a window, and stops it on quit.
const { app, BrowserWindow, dialog, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const SMOKE = process.argv.includes("--smoke"); // start, load the page, print a result, exit
const REPO = path.resolve(__dirname, "..");
const PYTHON = process.env.AGENT_CHAT_PYTHON || "python3";

app.setName("Agent Chat");
app.commandLine.appendSwitch("ozone-platform-hint", "auto"); // native Wayland when available

let server = null;
let win = null;
let baseUrl = null;
let serverUp = false;
let quitting = false;

// A fixed port keeps the page's origin the same between launches, so settings like the theme stick.
const PREFERRED_PORT = 48765;

function startServer(port) {
  return new Promise((resolve, reject) => {
    server = spawn(PYTHON, ["-u", "-m", "agentchat", "--port", String(port)], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error("The chat server did not start within 15 seconds.")), 15000);
    server.stdout.on("data", (chunk) => {
      out += chunk;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !serverUp) {
        serverUp = true;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${PYTHON}: ${err.message}`));
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      if (quitting) return;
      if (!serverUp) return reject(new Error(`The chat server stopped (exit ${code}).`));
      dialog.showErrorBox("Agent Chat", `The chat server stopped (exit ${code}). The app will close.`);
      app.quit();
    });
  });
}

function stopServer() {
  quitting = true;
  if (server && !server.killed) server.kill();
}

function openExternally(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    show: !SMOKE,
    title: "Agent Chat",
    backgroundColor: "#111b21",
    icon: nativeImage.createFromPath(path.join(__dirname, "icon.png")),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);

  // The window only ever shows the local chat page; anything else opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      openExternally(url);
    }
  });
  win.on("closed", () => (win = null));
  win.loadURL(baseUrl);
}

async function smokeCheck() {
  const timer = setTimeout(() => {
    console.log("SMOKE fail: page did not finish loading in 20 seconds");
    app.exit(1);
  }, 20000);
  win.webContents.once("did-finish-load", async () => {
    try {
      await new Promise((r) => setTimeout(r, 800)); // let the first chat list fetch finish
      const info = await win.webContents.executeJavaScript(
        "JSON.stringify({chats: document.querySelectorAll('.chat').length, title: document.title})"
      );
      clearTimeout(timer);
      const parsed = JSON.parse(info);
      console.log(`SMOKE ${parsed.chats > 0 ? "ok" : "fail"} ${info}`);
      app.exit(parsed.chats > 0 ? 0 : 1);
    } catch (err) {
      console.log("SMOKE fail:", err.message);
      app.exit(1);
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // already running: the existing window is brought forward below
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", stopServer);
  process.on("exit", stopServer);

  app.whenReady().then(async () => {
    try {
      try {
        baseUrl = await startServer(PREFERRED_PORT);
      } catch (_) {
        serverUp = false; // port busy or the first start failed: take any free port
        baseUrl = await startServer(0);
      }
    } catch (err) {
      if (SMOKE) {
        console.log("SMOKE fail:", err.message);
        app.exit(1);
        return;
      }
      dialog.showErrorBox("Agent Chat could not start", err.message);
      app.quit();
      return;
    }
    createWindow();
    if (SMOKE) smokeCheck();
  });
}
