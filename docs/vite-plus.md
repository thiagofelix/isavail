# Vite+ monorepo workflow

Vite+ owns repository checks and workspace task execution. The root `vite.config.ts` contains shared formatting, linting, type-checking, and Vite Task defaults; workspace `vite.config.ts` files own package-specific task graphs.

## Workspace boundaries

- `apps/*` contains independently runnable or deployable composition roots.
- `packages/*` contains cohesive capabilities shared by applications.
- Declare every workspace edge in the importing workspace's `package.json`; Vite Task uses this dependency graph for scheduling.
- Applications may depend on packages, but packages must not depend on applications.

## Vite Task policy

Package scripts are uncached by default. Configured tasks are cached by default, but every task that synchronizes external state or starts a long-running process (`dev`, `start`, `generate:openapi`) must set `cache: false`.

App lifecycle commands (`dev`, `build`, `start`, `generate:openapi`) belong in workspace Vite tasks rather than duplicate package scripts. Root aliases invoke those tasks through exact `package#task` selectors so every entrypoint uses the same dependency graph.

Task prerequisites belong in `dependsOn`. For example, `@isavail/isavail#start` depends on `build`.

A task specifier names one task, so tasks that must run side by side for their whole life (the dev server and Vite) are started by one supervising script, `apps/isavail/scripts/dev.ts`, rather than by the task graph.

Runner flags precede task names. Use exact `package#task` selectors for infrastructure operations and `--fail-if-no-match` with filters in automation.
