import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";
import { installWindowActivity } from "./windowActivity.ts";

if ("dashboardShell" in window) {
  const root = document.documentElement;
  root.dataset.shell = "app";
  // The window buttons are drawn by macOS at a fixed size, so they cover more of
  // the page when it is zoomed out and less when zoomed in. The styles divide by this.
  const syncZoom = () => root.style.setProperty("--shell-zoom", (window.outerWidth / window.innerWidth || 1).toFixed(3));
  syncZoom();
  window.addEventListener("resize", syncZoom);
}
installWindowActivity();

createRoot(document.getElementById("root")!).render(<App />);
