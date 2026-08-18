import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome131",
    minify: "esbuild",
    // The desktop bundle is shipped with open source, but embedding source
    // maps in every installer adds size and exposes local build paths without
    // improving runtime diagnostics.
    sourcemap: false,
  },
});
