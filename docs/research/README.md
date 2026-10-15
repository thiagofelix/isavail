# Research

Cloudflare Workflows research, gathered 2026-10-07 to support the benchmark and the pool design.

| Document                                                                           | Covers                                                                                                                                                                       | Basis                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`workflows-api-and-dynamic-workflows.md`](workflows-api-and-dynamic-workflows.md) | Workflow binding and instance API, `waitForEvent`/`sendEvent` constraints, limits, Dynamic Workflows                                                                         | Web sources, adversarially verified                            |
| [`alchemy-v2-workflows.md`](alchemy-v2-workflows.md)                               | Alchemy v2 Workflow definition, step primitives, Worker handle, deploy props, local dev wiring, `@cloudflare/workers-types` declarations, a type-checked parked-pool example | Installed `alchemy@2.0.0-beta.81` and workers-types source     |
| [`workflows-runtime-internals.md`](workflows-runtime-internals.md)                 | workerd binding/entrypoint, the per-instance Engine Durable Object, the `create()` path, replay, sleep, event delivery, eviction, local vs production differences            | Vendored `workflows-shared`, workerd and workers-sdk on GitHub |
| [`workflow-examples.md`](workflow-examples.md)                                     | Canonical saga and durable-workflow examples (Temporal, Restate, DBOS, AWS, Azure, Inngest, Cloudflare) assessed as benchmark/demo workloads; ranked shortlist               | Vendor samples and docs on the web                             |

## What this means for the thesis

- No public source measures how long it takes from `create()` to the first step. Whether the
  800 ms–1.5 s start cost is real, and whether `sendEvent()` to a parked instance beats it, still has
  to be measured on a deployed Worker.
- Local timing cannot answer it. The local engine starts `run()` directly with no queue, alarm or
  eviction, while production leases concurrency slots and evicts idle engines (inferred grace period
  of about 5 minutes). The benchmark should vary how long an instance has been parked, so it can show
  whether eviction erases the pre-start advantage.
- Parked instances do not count toward the 50,000 concurrency limit. Refill is capped at 100
  creations/s per workflow (300/s per account), and `waitForEvent` times out after 24 h by default.
