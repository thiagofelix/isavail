import { defineConfig } from "vite-plus";

/**
 * Bundles the server and every dependency it imports into one file,
 * `dist/server/main.js`, so running it needs only Node and the built website
 * beside it in `dist/client`. Node built-ins such as `node:sqlite` stay
 * external.
 */
export default defineConfig({
  build: {
    ssr: "src/server/main.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node24",
    sourcemap: true,
    rolldownOptions: {
      output: { entryFileNames: "main.js" },
    },
  },
  ssr: {
    target: "node",
    noExternal: true,
  },
});
