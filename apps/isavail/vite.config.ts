import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite-plus";

/** Port the server listens on by default; `vp dev` forwards `/v1` to it. */
const SERVER_PORT = 4310;

/**
 * Builds the website into `dist/client` and serves it under `vp dev`. The
 * server bundle has its own config, `vite.server.config.ts`.
 */
export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/client/entry.ts"],
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    proxy: {
      "/v1": `http://127.0.0.1:${SERVER_PORT}`,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  run: {
    tasks: {
      dev: { command: "node scripts/dev.ts", cache: false },
      build: { command: "vp build && vp build --config vite.server.config.ts" },
      start: { command: "node dist/server/main.js", cache: false, dependsOn: ["build"] },
      "generate:openapi": { command: "node scripts/generate-openapi.ts", cache: false },
    },
  },
});
