import { effectNative, presets as effectTsgoPresets } from "@effect/tsgo/oxlint-presets";
import foldkitAllPreset from "@foldkit/oxlint-plugin/all.json" with { type: "json" };
import { defineConfig } from "vite-plus";

const asErrors = (ruleNames: Iterable<string>): Record<string, "error"> =>
  Object.fromEntries(Array.from(new Set(ruleNames), (ruleName) => [ruleName, "error"]));

// Every rule from every @effect/tsgo preset (correctness, antipattern, effect-native,
// style, maintainers, recommended, strict), promoted to errors.
const allEffectTsgoRules = asErrors(
  Object.values(effectTsgoPresets).flatMap((preset) => Object.keys(preset.rules ?? {})),
);

// Every rule the Foldkit plugin ships, including the ones its preset leaves off by default.
const allFoldkitRules = asErrors(Object.keys(foldkitAllPreset.rules));

const disabled = (ruleNames: Iterable<string>): Record<string, "off"> =>
  Object.fromEntries(Array.from(ruleNames, (ruleName) => [ruleName, "off"]));

const testFiles = ["**/test/**/*.ts", "**/*.test.ts", "**/*.spec.ts"];

const generatedAndVendored = [
  "repos/**",
  "**/dist/**",
  "**/.alchemy/**",
  "**/.wrangler/**",
  "**/openapi.json",
];

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
        files: ["**/*.ts", "**/*.js"],
        plugins: ["effecttsgo"],
        // Rule options (unstable/experimental API allowlists, barrel imports) live in the
        // @effect/language-service plugin entry of each tsconfig.json.
        rules: {
          ...allEffectTsgoRules,
          ...allFoldkitRules,
        },
      },
      {
        // The root Vite+ config and the isavail Oxlint plugin do not depend on Effect, so
        // rules that replace native APIs with Effect modules do not apply to them.
        files: ["vite.config.ts", "tools/**"],
        plugins: ["effecttsgo"],
        rules: disabled(Object.keys(effectNative.rules ?? {})),
      },
      {
        // Each test is its own entry point: it provides layers built from per-test values
        // such as a fake registry's port or a presented token. Story tests drive `update`
        // by constructing Messages directly, which is how Foldkit's Story API works.
        files: testFiles,
        plugins: ["effecttsgo"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
          "foldkit/no-child-message-construction-in-root": "off",
        },
      },
      {
        // Scripts are entry points: each one provides the platform layers it runs on.
        files: ["**/scripts/**/*.ts"],
        plugins: ["effecttsgo"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
        },
      },
      {
        // Browser-only code: `document` and `location` are the platform here, and the rule
        // guards Foldkit server targets.
        files: ["apps/web/src/client/**/*.ts"],
        rules: {
          "foldkit/no-nonportable-server-globals": "off",
        },
      },
    ],
  },
  run: {
    cache: true,
  },
});
