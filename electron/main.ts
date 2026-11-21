/**
 * The macOS app around the dashboard: a window on the daemon's own page.
 *
 * The daemon (server/) keeps running when the app quits, and its sessions with
 * it; only "Quit and Stop Daemon…" ends it. A daemon left over from an older
 * build is offered a restart, since that is the one thing that ends sessions.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL, DATA_DIR, ensureDaemon, health, LINK_SCHEME, locateDaemon, LOG_PATH, stopDaemon, type Health } from "./daemon.ts";

const APP_NAME = "Claude Dashboard";
const HERE = dirname(fileURLToPath(import.meta.url));
const WATCH_MS = 5_000;
const RESPAWN_LIMIT = 3;
const WINDOW_STEP = 28;
/** Every window hears of the same notification; only the first within this long raises a banner. */
const BANNER_ECHO_MS = 3_000;

const daemon = locateDaemon(process.resourcesPath, app.isPackaged, process.env.DASHBOARD_CHECKOUT ?? process.cwd());

let win: BrowserWindow | null = null;
let stopping = false;
let respawns = 0;
let watching: NodeJS.Timeout | null = null;
/** A link that arrived before the window existed. */
let pendingHash: string | null = null;
/** Banners still on screen, by what they are about: a newer one for the same thing replaces the old. */
const banners = new Map<string, Notification>();
const bannerAt = new Map<string, number>();

/**
 * Each window's number: 1 for the first, then the lowest one free. Every window
 * after the first has browser storage of its own under that number, which is
 * what gives it its own zoom, theme, sidebar and desktops: Chromium keeps all
 * of those per storage partition, and "the second window" finds its own again
 * the next time it is opened.
 */
const slots = new Map<BrowserWindow, number>();

function freeSlot(): number {
  const taken = new Set(slots.values());
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
}

/**
 * What the first window keeps in the browser's storage, handed to a further
 * window the first time it opens so it starts as a copy rather than on defaults.
 */
let seed: [string, string][] = [];

async function takeSeed() {
  const first = [...slots].find(([, n]) => n === 1)?.[0];
  if (!first || first.isDestroyed()) return;
  try {
    seed = (await first.webContents.executeJavaScript("Object.entries(localStorage)")) as [string, string][];
  } catch {
    seed = [];
  }
}

const statePath = () => join(app.getPath("userData"), "window.json");
const iconPath = () => join(app.getPath("userData"), "dock-icon.png");

type Bounds = { x?: number; y?: number; width: number; height: number };

function readBounds(): Bounds {
  try {
    const b = JSON.parse(readFileSync(statePath(), "utf8")) as Bounds;
    if (b.width >= 720 && b.height >= 480) return b;
  } catch {
    return { width: 1500, height: 950 };
  }
  return { width: 1500, height: 950 };
}

function saveBounds(w: BrowserWindow) {
  if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
  try {
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(w.getNormalBounds()));
  } catch {
    return;
  }
}

const isAppUrl = (url: string) => url === APP_URL || url.startsWith(`${APP_URL}/`);

/** Links leave for the default browser; only the dashboard itself loads in the window. */
function guardNavigation(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
}

/** Where a further window opens: the size of the one in front, a step down and to the right of it. */
function besideBounds(front: BrowserWindow): Bounds {
  const b = front.getNormalBounds();
  return { x: b.x + WINDOW_STEP, y: b.y + WINDOW_STEP, width: b.width, height: b.height };
}

const allWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

function createWindow() {
  const front = win && !win.isDestroyed() ? win : null;
  const slot = freeSlot();
  const w = new BrowserWindow({
    ...(front ? besideBounds(front) : readBounds()),
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: "#121211",
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      additionalArguments: [`--dashboard-slot=${slot}`],
      ...(slot === 1 ? {} : { partition: `persist:window-${slot}` }),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win = w;
  slots.set(w, slot);
  w.once("ready-to-show", () => w.show());
  w.on("focus", () => (win = w));
  w.on("close", () => {
    if (slot === 1) saveBounds(w);
  });
  w.on("closed", () => {
    slots.delete(w);
    if (win === w) win = allWindows()[0] ?? null;
  });
  guardNavigation(w);
  void w.loadURL(`${APP_URL}/${pendingHash ?? ""}`);
  pendingHash = null;
}

/** Brings the window forward on the page a `claude-dashboard://open/#/…` link names. */
function follow(link: string) {
  let hash = "";
  try {
    const url = new URL(link);
    if (url.protocol !== `${LINK_SCHEME}:`) return;
    hash = url.hash;
  } catch {
    return;
  }
  if (!win) {
    pendingHash = hash;
    if (app.isReady() && !stopping) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (hash) void win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}

function fatal(message: string): never {
  dialog.showErrorBox(APP_NAME, message);
  app.exit(1);
  throw new Error(message);
}

/** A daemon from another build still speaks the old API to a new page: offer the restart that fixes it. */
async function offerUpgrade(running: Health) {
  if (!daemon.build || running.build === daemon.build || !running.pid) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Restart Daemon", "Keep It Running"],
    defaultId: 0,
    cancelId: 1,
    message: "The dashboard daemon is from another build.",
    detail: `It runs ${running.version ?? "an unknown version"}${running.build ? ` (${running.build})` : ""}; this app ships ${daemon.build}. Restarting it ends the sessions it is running; they stay listed and can be resumed.`,
  });
  if (response !== 0) return;
  if (!(await stopDaemon(running.pid))) fatal(`The daemon (pid ${running.pid}) did not stop.`);
  await ensureDaemon(daemon);
}

/** The daemon went away on its own: start another, a few times at most, and load the page again. */
function watchDaemon() {
  if (watching) clearInterval(watching);
  watching = setInterval(() => {
    void (async () => {
      if (stopping || (await health())) return;
      if (respawns >= RESPAWN_LIMIT) {
        if (watching) clearInterval(watching);
        fatal(`The daemon stopped ${RESPAWN_LIMIT} times; giving up.\n\nIts log is at ${LOG_PATH}.`);
      }
      respawns += 1;
      try {
        await ensureDaemon(daemon);
        for (const w of allWindows()) w.webContents.reload();
      } catch (err) {
        fatal(err instanceof Error ? err.message : String(err));
      }
    })();
  }, WATCH_MS);
}

async function quitAndStop() {
  const running = await health();
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Quit and Stop", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Stop the dashboard daemon too?",
    detail: "The sessions it is running end. They stay listed and can be resumed the next time.",
  });
  if (response !== 0) return;
  stopping = true;
  if (running?.pid) await stopDaemon(running.pid);
  app.quit();
}

async function restartDaemon() {
  const running = await health();
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Restart Daemon", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Restart the dashboard daemon?",
    detail: "The sessions it is running end. They stay listed and can be resumed.",
  });
  if (response !== 0) return;
  stopping = true;
  try {
    if (running?.pid && !(await stopDaemon(running.pid))) fatal(`The daemon (pid ${running.pid}) did not stop.`);
    await ensureDaemon(daemon);
    for (const w of allWindows()) w.webContents.reload();
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  } finally {
    stopping = false;
  }
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Restart Daemon…", click: () => void restartDaemon() },
        { label: "Show Daemon Log", click: () => void shell.openPath(LOG_PATH) },
        { label: "Show Data Folder", click: () => void shell.openPath(DATA_DIR) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit and Stop Daemon…", click: () => void quitAndStop() },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => void takeSeed().then(createWindow) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyDockIcon() {
  if (!app.dock || !existsSync(iconPath())) return;
  const image = nativeImage.createFromPath(iconPath());
  if (!image.isEmpty()) app.dock.setIcon(image);
}

function installIpc() {
  const fromApp = (url: string | undefined) => !!url && isAppUrl(url);
  ipcMain.on("shell:dock-icon", (e, dataUrl: unknown) => {
    if (!fromApp(e.senderFrame?.url) || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return;
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return;
    try {
      mkdirSync(dirname(iconPath()), { recursive: true });
      writeFileSync(iconPath(), image.toPNG());
    } catch {
      return;
    }
    app.dock?.setIcon(image);
  });
  ipcMain.on("shell:notify", (e, notice: unknown) => {
    if (!fromApp(e.senderFrame?.url) || !Notification.isSupported()) return;
    const n = notice as { key?: unknown; title?: unknown; body?: unknown; href?: unknown };
    if (typeof n?.key !== "string" || typeof n.title !== "string") return;
    const now = Date.now();
    if (now - (bannerAt.get(n.key) ?? 0) < BANNER_ECHO_MS) return;
    bannerAt.set(n.key, now);
    const key = n.key;
    const href = typeof n.href === "string" && n.href.startsWith("#") ? n.href : "";
    banners.get(key)?.close();
    const banner = new Notification({ title: n.title, body: typeof n.body === "string" ? n.body : "" });
    banners.set(key, banner);
    banner.on("click", () => follow(`${LINK_SCHEME}://open/${href}`));
    banner.on("close", () => {
      if (banners.get(key) === banner) banners.delete(key);
    });
    banner.on("failed", (_e, error) => console.error(`[app] notification failed: ${error}`));
    banner.show();
  });
  ipcMain.on("shell:seed", (e) => {
    e.returnValue = fromApp(e.senderFrame?.url) ? seed : [];
  });
  ipcMain.on("shell:badge", (e, count: unknown) => {
    if (!fromApp(e.senderFrame?.url)) return;
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    app.dock?.setBadge(n > 0 ? String(n) : "");
  });
}

/**
 * A long diff is a very tall page. Past Chromium's default budget for drawn
 * tiles, stretches of it stay blank after a scroll until something (a hover)
 * forces a repaint; a larger budget keeps them drawn.
 */
app.commandLine.appendSwitch("force-gpu-mem-available-mb", "4096");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName(APP_NAME);
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    follow(url);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!win && app.isReady()) createWindow();
  });

  void app.whenReady().then(async () => {
    buildMenu();
    applyDockIcon();
    installIpc();
    try {
      const attached = await ensureDaemon(daemon);
      if (!attached.spawned) await offerUpgrade(attached.health);
    } catch (err) {
      fatal(`Could not start the dashboard daemon.\n\n${err instanceof Error ? err.message : err}`);
    }
    createWindow();
    watchDaemon();
  });
}
