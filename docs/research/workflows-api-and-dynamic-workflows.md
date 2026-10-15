# Cloudflare Workflows: API, limits, and Dynamic Workflows

Researched 2026-10-07 with the `deep-research` workflow: 6 search angles, 21 sources fetched, 90
claims extracted, top 25 adversarially verified (3 votes each; 2 refutes kill a claim). 23 claims
survived and 2 were refuted. Votes are recorded per finding.

Limits changed twice between Oct 2025 and Apr 2026; re-check
[the limits page](https://developers.cloudflare.com/workflows/reference/limits/) before relying on a
number. The installed type declarations and the Alchemy source are documented in
[`alchemy-v2-workflows.md`](alchemy-v2-workflows.md); runtime internals are in
[`workflows-runtime-internals.md`](workflows-runtime-internals.md).

## Workflow binding

_Source: [Workers API reference](https://developers.cloudflare.com/workflows/build/workers-api). Vote 3-0._

- `create(options)`: starts one instance. **Throws if the ID belongs to an instance still inside its
  retention window.**
- `createBatch(batch)`: 1–100 instances, idempotent. **Duplicate IDs are skipped silently and left
  out of the returned array, so the result is not index-aligned with the input.**
- `get(id)`: throws for an unknown ID.
- Retention precedence: instance setting → binding `default_retention` → account maximum (3 days
  Free, 30 days Paid).

## WorkflowInstance

_Sources: Workers API reference; [Alchemy add-a-workflow](https://alchemy.run/cloudflare/compute/add-a-workflow). Vote 3-0._

- `id`, `status()`, `pause()`, `resume()`, `terminate({ rollback?: boolean })`, `restart()` (from
  the beginning, or from a specific step identified by name, count and type),
  `sendEvent({ type, payload })`, `delete()` (removes stored state), `subscribe()`.
- `terminate({ rollback: true })` runs the rollback handlers registered by completed steps before
  the instance reaches `terminated`.
- Status values include `queued`, `running`, `paused`, `waiting`, `complete`, `errored`,
  `terminated`.

## `step.waitForEvent` and `sendEvent`

_Source: Workers API reference. Vote 3-0._

- `step.waitForEvent(name, { type, timeout? })` times out after **24 hours by default** and throws
  on timeout.
- `type` is limited to **100 characters**, for both `waitForEvent` and `sendEvent`.
- `sendEvent` throws if the instance is not running or has errored.
- The maximum configurable timeout was **not** verified.

**Pool implication:** a parked instance without an explicit timeout expires after 24 h, unless the
timeout is caught and the instance waits again. Sending to an expired instance fails, so dispatch
must handle that failure and fall back.

## Limits

_Sources: [2026-04-15 changelog](https://developers.cloudflare.com/changelog/post/2026-04-15-workflows-limits-raised/),
[2025-10-28 changelog](https://developers.cloudflare.com/changelog/post/2025-10-28-raising-limits/index.md),
[limits page](https://developers.cloudflare.com/workflows/reference/limits/)._

| Limit                                | Value                                     | Vote      |
| ------------------------------------ | ----------------------------------------- | --------- |
| Concurrent running instances (Paid)  | 50,000 (raised from 10,000 on 2026-04-15) | 3-0       |
| Concurrent running instances (Free)  | 100                                       | 3-0       |
| Instance creation rate, per account  | 300/s (Paid), 100/s (Free)                | 3-0       |
| Instance creation rate, per workflow | 100/s                                     | 3-0 / 2-1 |
| Over the creation rate               | HTTP 429                                  | 3-0       |

Instances that are waiting (`step.sleep`, retry backoff, `step.waitForEvent`) **do not count**
toward the concurrency limit.

**Pool implications:**

- Parked instances do not use up concurrency slots, so pool size is not bounded by the 50,000 limit.
  Whether they cost storage or retention has not been checked.
- Refill for a single workflow is capped at 100 creations/s. Spreading the pool across several
  workflow definitions could reach the 300/s account cap in total.
- Refill bursts must handle 429s.

## Execution model: replay

_Derived from verifier notes on the Alchemy and Dynamic Workflows claims; not a dedicated verified
claim. Confidence: medium. See the runtime-internals doc for the code-level answer._

- After a wake-up (sleep, event, crash, deploy) the engine calls `run()` again from the start.
  Completed steps return their cached results, so execution resumes at step boundaries, not in the
  middle of a function.
- Steps run **at least once**. Code outside a step runs again on every replay.
- Alchemy's docs describe tasks as "exactly once", which is stronger than the native guarantee.
  Treat tasks as at-least-once and make them idempotent.

## Dynamic Workflows

_Sources: [blog](https://blog.cloudflare.com/dynamic-workflows),
[changelog 2026-05-01](https://developers.cloudflare.com/changelog/post/2026-05-01-dynamic-workflows/),
[usage](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/),
[example](https://developers.cloudflare.com/dynamic-workers/examples/dynamic-workflows/). Vote 3-0
throughout._

Dynamic Workflows is **a library, not a separate engine**. `@cloudflare/dynamic-workflows`
(about 300 lines of TypeScript, MIT, v0.1.1 at research time, announced 2026-05-01,
[repo](https://github.com/cloudflare/dynamic-workflows)) runs Workflows written by tenants or AI
agents inside Dynamic Workers (Worker Loader), on the standard Workflows engine. Dynamic Workers
handle sandboxing, RPC, isolate caching and hibernation.

**The problem it solves:** a Workflow can sleep for hours or days. By the time it resumes, code
loaded at runtime is no longer in memory, so it must be reloaded on every wake-up.

**It has three parts:**

1. A deployed **Worker Loader**. It receives requests, picks the tenant and creates instances.
2. A per-tenant **Dynamic Worker**, which defines the steps.
3. A **`DynamicWorkflow` entrypoint** registered in the Wrangler config:

   ```ts
   createDynamicWorkflowEntrypoint(async ({ env, metadata }) =>
     env.LOADER.get(tenantId, ...).getEntrypoint("TenantWorkflow"),
   );
   ```

   When the engine is ready to run a step it calls `.run(event, step)` on this class, which forwards
   to the reloaded tenant code.

**Routing via `wrapWorkflowBinding({ tenantId })`:**

- It gives the tenant what looks like an ordinary binding, but rewrites
  `create({ params: P })` to
  `create({ params: { __workerLoaderMetadata: { tenantId }, params: P } })`.
- The metadata is stored with the instance params and travels with every wake-up.
- Tenants can read it back through `instance.status()`. It is a routing hint, not authorization, and
  must not hold secrets.

**Relevance here:** Dynamic Workflows adds a Worker Loader lookup on every resume, so it does not
remove start latency. Because it shares the engine, a pre-started pool would work the same way for
dynamic tenants.

## Refuted or unresolved

- "Concurrency went from 4,500 to 10,000 in Oct 2025" was refuted 0-3, but a different verifier read
  the same changelog as saying exactly that. Unresolved; it no longer matters because of the
  2026-04 raise.
- "`v2.alchemy.run` URLs redirect to v1 content" was refuted 0-3, though another verifier described
  that same redirect chain. Use the installed source, not the website, for Alchemy v2.

## Open questions for the benchmark

1. Measured on a deployed Worker, at p50/p90/p99:
   - latency from `create()` resolving to the first step running;
   - latency from `sendEvent()` to a parked instance's next step running.

   Is the parked path actually faster? No outside evidence was found either way; the 800 ms–1.5 s
   thesis is still unsupported.

2. What is the maximum `waitForEvent` timeout? Do parked instances use storage or retention in a way
   that limits pool size or lifetime?
3. Is the user Worker's isolate still warm when a parked instance wakes? Does the engine place the
   instance near the caller?
