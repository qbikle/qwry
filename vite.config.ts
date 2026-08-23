import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    // stores are cross-module singletons (zustand instances, module timers,
    // tauri listeners). HMR re-evaluates them for SOME importers only:
    // components grab the fresh store while side-effect modules (heal.ts)
    // keep writing to the old one — actions fire, nobody re-renders. A store
    // edit is a full-reload, never a hot swap.
    {
      name: "full-reload-stores",
      handleHotUpdate({ file, server }: { file: string; server: { ws: { send(p: { type: "full-reload" }): void } } }) {
        if (file.includes("/src/stores/")) {
          server.ws.send({ type: "full-reload" });
          return [];
        }
      },
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
