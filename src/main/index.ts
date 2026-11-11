// Desktop shell (Electron): runs the chat server in this process and shows it in a window.
import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, shell } from "electron";
import { boot, type Booted } from "./boot.ts";

const SMOKE = process.argv.includes("--smoke"); // start, load the page, print a result, exit
const PORT = Number(process.env.AGENT_CHAT_PORT || 48765); // a fixed port keeps the page's origin, so settings like the theme stick
const root = app.getAppPath();

app.setName("Agent Chat");
app.commandLine.appendSwitch("ozone-platform-hint", "auto"); // native Wayland when available

let booted: Booted | null = null;
let win: BrowserWindow | null = null;

function openExternally(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

async function createWindow(baseUrl: string): Promise<void> {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    show: !SMOKE,
    title: "Agent Chat",
    backgroundColor: "#111b21",
    icon: nativeImage.createFromPath(path.join(root, "resources", "icon.png")),
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
  await win.loadURL(process.env.ELECTRON_RENDERER_URL || baseUrl); // in `npm run dev` the page comes from Vite (hot reload)
}

async function smokeTest(): Promise<void> {
  const js = `JSON.stringify({chats: document.querySelectorAll('.chat').length, title: document.title})`;
  for (let i = 0; i < 30; i++) {
    const result = await win!.webContents.executeJavaScript(js);
    const parsed = JSON.parse(result);
    if (parsed.chats > 0) {
      console.log("SMOKE ok " + result);
      return app.quit();
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log("SMOKE failed: no chats rendered");
  app.exit(1);
}

const lock = SMOKE ? true : app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(async () => {
    try {
      booted = await boot({
        root,
        port: PORT,
        agentsDir: path.resolve(process.env.AGENT_CHAT_AGENTS || path.join(root, "agents")),
        dataDir: path.resolve(process.env.AGENT_CHAT_DATA || path.join(root, "data")),
        staticDir: path.join(root, "out", "renderer"),
      });
      await createWindow(`http://127.0.0.1:${booted.served.port}`);
      if (SMOKE) await smokeTest();
    } catch (e) {
      dialog.showErrorBox("Agent Chat", String((e as Error).message ?? e));
      app.exit(1);
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => void booted?.stop());
}
