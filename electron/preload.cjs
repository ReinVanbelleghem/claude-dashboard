// The bridge between the page and the app around it. CommonJS on purpose:
// a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer } = require("electron");

const slotArg = process.argv.find((a) => a.startsWith("--dashboard-slot="));

// A further window has storage of its own. The first time it opens, that is
// empty: it takes a copy of the first window's, before the page reads any of it.
try {
  if (slotArg && !slotArg.endsWith("=1") && window.localStorage.length === 0) {
    for (const [key, value] of ipcRenderer.sendSync("shell:seed")) window.localStorage.setItem(key, value);
  }
} catch {
  // Starting on defaults is fine.
}

contextBridge.exposeInMainWorld("dashboardShell", {
  /** Which of the app's windows this is: 1 for the first, counting up. */
  windowSlot: slotArg ? Number(slotArg.split("=")[1]) || 1 : 1,
  /** The Dock icon, as a PNG data URL; kept for the next launch. */
  setDockIcon: (dataUrl) => ipcRenderer.send("shell:dock-icon", dataUrl),
  /** How many sessions wait on you, as the Dock badge; 0 clears it. */
  setBadge: (count) => ipcRenderer.send("shell:badge", count),
  /** A banner in the notification centre, on whichever desktop you are looking at. */
  notify: (notice) => ipcRenderer.send("shell:notify", notice),
});
