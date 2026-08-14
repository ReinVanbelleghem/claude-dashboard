import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5758,
    // The daemon is the only process that touches ~/.claude; the UI talks to it.
    proxy: {
      "/api": { target: "http://localhost:5757", changeOrigin: true, ws: false },
    },
  },
  build: { outDir: "dist" },
});
