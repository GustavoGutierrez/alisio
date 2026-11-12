/**
 * Electron main process. It owns no Alisio logic: it starts the host (the Alisio server running on
 * the Electron binary as plain Node) and shows its web UI in a sandboxed window.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import { launchHost, type RunningHost } from "./host-process.ts";
import { classifyNavigation } from "./navigation.ts";
import { createPrinter } from "./print.ts";
import {
  buildHostSpawn,
  hostExitAction,
  resolveNpmCli,
  resolveRuntimePaths,
} from "./spawn-plan.ts";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 30_000;

let host: RunningHost | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let recentLog: string[] = [];
// Hidden-window printing for `document_create` (spec 026 D7); jobs live under a private 0700 root.
const printRoot = join(tmpdir(), `alisio-print-${process.pid}`);
const printer = createPrinter();

async function startHost(): Promise<RunningHost> {
  const paths = resolveRuntimePaths({
    packaged: app.isPackaged,
    appDir: APP_DIR,
    resourcesPath: process.resourcesPath,
  });
  mkdirSync(printRoot, { recursive: true, mode: 0o700 });
  const plan = buildHostSpawn({
    print: {
      root: printRoot,
      version: `Electron ${process.versions.electron} (Chromium ${process.versions.chrome})`,
    },
    execPath: process.execPath,
    hostEntry: paths.hostEntry,
    parentEnv: process.env,
    // The same loopback port every launch: the web UI keeps its preferences (same origin).
    portFile: join(app.getPath("userData"), "host-port.json"),
    // Packaged builds bundle npm: the app installs plugins without a system Node.js.
    ...(existsSync(resolveNpmCli(paths.runtimeDir))
      ? { npmCli: resolveNpmCli(paths.runtimeDir) }
      : {}),
  });
  recentLog = [];
  const running = await launchHost({
    ...plan,
    cwd: paths.runtimeDir,
    timeoutMs: READY_TIMEOUT_MS,
    print: {
      root: printRoot,
      run: (request) => printer.print(request),
      cancel: (id) => printer.cancel(id),
    },
    onLog: (line) => {
      recentLog = [...recentLog.slice(-19), line];
    },
  });
  // A host that dies later takes the UI with it: offer a restart instead of a dead window.
  void running.exited.then((code) => {
    const action = hostExitAction(code, { quitting, current: host === running });
    // A requested restart (a plugin update that needs a fresh process) respawns silently and
    // reloads the window onto the new launch URL: no error page.
    if (action === "restart") void launch();
    else if (action === "recover") void recover("The Alisio background process stopped.");
  });
  return running;
}

function createWindow(launchUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "Alisio",
    // Taskbar/window icon on Linux and Windows (macOS uses the bundle icon).
    icon: join(APP_DIR, "build-resources", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const openExternally = (url: string) => {
    const action = classifyNavigation(url, launchUrl);
    if (action === "external") void shell.openExternal(url);
    return action;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (openExternally(url) !== "allow") event.preventDefault();
  });
  win.on("closed", () => {
    if (window === win) window = undefined;
  });
  void win.loadURL(launchUrl);
  return win;
}

async function recover(reason: string): Promise<void> {
  const detail = recentLog.length > 0 ? `\n\n${recentLog.join("\n")}` : "";
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "Alisio",
    message: reason,
    detail: detail.trim() || undefined,
    buttons: ["Retry", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await launch();
  else app.quit();
}

async function launch(): Promise<void> {
  const previous = host;
  host = undefined;
  await previous?.stop();
  try {
    host = await startHost();
  } catch (error) {
    await recover(error instanceof Error ? error.message : "The Alisio host failed to start.");
    return;
  }
  if (window && !window.isDestroyed()) void window.loadURL(host.launchUrl);
  else window = createWindow(host.launchUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    rmSync(printRoot, { recursive: true, force: true });
    const running = host;
    host = undefined;
    if (!running) return;
    // Ask the host to shut down (IPC) and wait for it; a host that does not exit in time is
    // killed with its process tree (budget in host-protocol.ts), so quitting leaves nothing behind.
    event.preventDefault();
    void running.stop().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!window && host) window = createWindow(host.launchUrl);
  });
  void app.whenReady().then(launch);
}
