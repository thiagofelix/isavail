import { defineConfig } from "vite-plus";

const generatedAndVendored = [
  "repos/**",
  "**/dist/**",
  "**/.alchemy/**",
  "**/.wrangler/**",
  "**/openapi.json",
];

const testFiles = ["**/*.test.ts", "**/*.spec.ts"];

export default defineConfig({
  fmt: {
    ignorePatterns: generatedAndVendored,
    printWidth: 100,
  },
  lint: {
    ignorePatterns: generatedAndVendored,
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "isavail", specifier: "@isavail/oxlint-plugin" },
      { name: "foldkit", specifier: "@foldkit/oxlint-plugin" },
    ],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "isavail/no-service-constructor-import": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
    overrides: [
      {
        files: ["apps/web/src/client/**/*.ts"],
        excludeFiles: testFiles,
        rules: {
          "foldkit/command-binding-matches-name": "error",
          "foldkit/command-define-pascal-const": "error",
          "foldkit/keyed-required-for-mapped-rows": "error",
          "foldkit/no-array-index-view-keys": "error",
          "foldkit/no-empty-children-array": "error",
          "foldkit/no-empty-commands-array": "error",
          "foldkit/no-empty-object-tagged-call": "error",
          "foldkit/no-hand-rolled-command-struct": "error",
          "foldkit/no-module-level-mutable-state": "error",
          "foldkit/no-noop-message": "error",
          "foldkit/no-raw-dom-event-attributes": "error",
          "foldkit/no-spread-in-modify-fields": "error",
          "foldkit/no-switch-on-message-tag": "error",
          "foldkit/prefer-callable-message-constructor": "error",
          "foldkit/prefer-effect-module-names": "error",
          "foldkit/prefer-option-over-nullable-in-model": "error",
          "foldkit/require-rel-for-external-link": "error",
        },
      },
      {
        files: ["apps/web/src/client/entry.ts"],
        rules: {
          "foldkit/no-impure-call-at-decision-time": "off",
        },
      },
    ],
  },
  run: {
    cache: true,
  },
});
