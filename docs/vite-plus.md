# Vite+ monorepo workflow

Vite+ owns repository checks and workspace task execution. The root `vite.config.ts` contains shared formatting, linting, type-checking, and Vite Task defaults; workspace `vite.config.ts` files own package-specific task graphs.

## Workspace boundaries

- `apps/*` contains independently runnable or deployable composition roots.
- `packages/*` contains cohesive capabilities shared by applications.
- Declare every workspace edge in the importing workspace's `package.json`; Vite Task uses this dependency graph for scheduling.
- Applications may depend on packages, but packages must not depend on applications.

## Vite Task policy

Package scripts are uncached by default. Configured tasks are cached by default, but every task that deploys, destroys, plans, synchronizes external state, or starts a long-running process must set `cache: false`.

Alchemy infrastructure lifecycle commands belong in workspace Vite tasks rather than duplicate package scripts. Root aliases invoke those tasks through exact `package#task` selectors so every entrypoint uses the same dependency graph.

Cross-workspace infrastructure prerequisites belong in `dependsOn`. For example, an app's `deploy:production` task depends on `@example-svc/shared-infrastructure#deploy:production`.

Runner flags precede task names. Use exact `package#task` selectors for infrastructure operations and `--fail-if-no-match` with filters in automation.
