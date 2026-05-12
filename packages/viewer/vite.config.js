import { svelte } from "@sveltejs/vite-plugin-svelte";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

import { tsJsonSchemaPlugin } from "./scripts/vite-plugin-ts-json-schema.js";

// https://vitejs.dev/config/
export default defineConfig({
  base: "",
  plugins: [svelte(), wasm(), icons({ compiler: "svelte" }), tsJsonSchemaPlugin()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    // Proxy /data and /mcp to a running backend so `npm run dev`
    // works against a real DuckDB+Mosaic stack (port matches the
    // default the backend lands on; 5056 is the fallback for when
    // 5055 is in use). Override at run time with `BACKEND_PORT`.
    //
    // `ws: true` on `/data` is required so the viewer's MCP control
    // socket (`/data/mcp_websocket`) is upgraded through the proxy.
    // Without it the upgrade fails silently, the backend's
    // `mcp_bridge` has no viewer to dispatch tool calls to, and
    // chat tool calls (e.g. `query_sql`) return
    // "Viewer disconnected. Reload the viewer and try again."
    proxy: {
      "/data": {
        target: `http://localhost:${process.env.BACKEND_PORT ?? 5055}`,
        ws: true,
      },
      "/mcp": `http://localhost:${process.env.BACKEND_PORT ?? 5055}`,
    },
  },
});
