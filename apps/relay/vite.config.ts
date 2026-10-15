import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  run: {
    tasks: {
      dev: { command: "alchemy dev", cache: false },
      plan: { command: "alchemy plan", cache: false },
      deploy: { command: "alchemy deploy --yes", cache: false },
      "deploy:production": {
        command: "alchemy deploy --stage production --yes",
        cache: false,
        dependsOn: ["@isavail/shared-infrastructure#deploy"],
      },
      destroy: {
        command: "alchemy destroy --yes",
        cache: false,
        dependsOn: ["@isavail/web#destroy"],
      },
    },
  },
});
