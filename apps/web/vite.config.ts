import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/client/entry.ts"],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  run: {
    tasks: {
      dev: { command: "alchemy dev", cache: false },
      "generate:openapi": { command: "node scripts/generate-openapi.ts", cache: false },
      plan: { command: "alchemy plan", cache: false },
      deploy: {
        command: "alchemy deploy --yes",
        cache: false,
        dependsOn: ["@isavail/relay#deploy"],
      },
      "deploy:production": {
        command: "alchemy deploy --stage production --yes",
        cache: false,
        dependsOn: ["@isavail/relay#deploy:production"],
      },
      destroy: { command: "alchemy destroy --yes", cache: false },
    },
  },
});
