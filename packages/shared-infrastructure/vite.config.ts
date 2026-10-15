import { defineConfig } from "vite-plus";

// The observability Stack exists only at stage `production`; every task pins it.
export default defineConfig({
  run: {
    tasks: {
      plan: { command: "alchemy plan --stage production", cache: false },
      deploy: { command: "alchemy deploy --stage production --yes", cache: false },
      destroy: { command: "alchemy destroy --stage production --yes", cache: false },
    },
  },
});
