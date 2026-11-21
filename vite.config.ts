import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = `http://localhost:${process.env.PORT ?? 5757}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5758,
    // The daemon is the only process that touches ~/.claude; the UI talks to it.
    proxy: {
      "/api": { target: daemon, changeOrigin: true, ws: false },
      // The services terminal is a real websocket, so this one proxies the upgrade.
      "/pty": { target: daemon, changeOrigin: true, ws: true },
      // Excalidraw's fonts, which the daemon serves out of the installed package.
      "/excalidraw-assets": { target: daemon, changeOrigin: true, ws: false },
    },
  },
  // xterm 6 declares an enum inside a method, and esbuild's syntax minifier drops
  // the declaration it assigns to: the built terminal then dies on the first
  // mode query tmux sends. Names and whitespace are still minified.
  esbuild: { minifySyntax: false },
  build: { outDir: "dist" },
});
