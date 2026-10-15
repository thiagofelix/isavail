# Cloudflare Workflows: runtime internals

Researched 2026-10-07 by reading source code. A web-research pass found no verifiable public claims
about Workflows internals, so this document relies on code: the local engine that this repo
actually runs, workerd, and upstream workers-sdk. Cloudflare's own blog posts are the only source
for production behavior, and their claims are marked separately.

Each statement carries one of these labels:

- **[code]**: verified by reading the cited source at the cited line(s).
- **[prod-claim]**: stated by Cloudflare in a blog post or in the docs. It cannot be checked against
  code because the production engine is closed source.
- **[inference]**: my reasoning from code or claims, not verified by running anything.

Nothing in this document was verified by running code.

## Sources and versions

| Label               | What                                                                                                          | Where                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VENDOR`            | Local engine vendored by Alchemy (`@alchemy.run/cloudflare-runtime@2.0.0-beta.81`)                            | `node_modules/.pnpm/@alchemy.run+cloudflare-runtime@2.0.0-beta.81_@distilled.cloud+cloudflare@1.0.0-rc.13_e_f3939caf4595de1f86c2e3dead5adc68/node_modules/@alchemy.run/cloudflare-runtime/src/internal/workflows-shared/` |
| `ALCHEMY`           | How Alchemy wires that engine into the workerd config                                                         | same package, `src/core/bindings/workflows/{Workflows.ts,wrapped-binding.worker.ts,binding.worker.ts}`                                                                                                                    |
| upstream @ vendored | `cloudflare/workers-sdk` `packages/workflows-shared`, the commit `VENDOR` was copied from (README provenance) | [`f9e7727d`](https://github.com/cloudflare/workers-sdk/tree/f9e7727dbef58e71c6b297dc688d3c544cef87cb/packages/workflows-shared), 2026-09-18                                                                               |
| upstream @ HEAD     | the same package at `main`                                                                                    | [`e3d18677`](https://github.com/cloudflare/workers-sdk/tree/e3d186776fcc2e4b5cc4cfd7155591778a375957/packages/workflows-shared), 2026-10-07                                                                               |
| miniflare           | miniflare's Workflows plugin                                                                                  | [`packages/miniflare/src/plugins/workflows/index.ts@e3d18677`](https://github.com/cloudflare/workers-sdk/blob/e3d186776fcc2e4b5cc4cfd7155591778a375957/packages/miniflare/src/plugins/workflows/index.ts)                 |
| workerd             | tag `v1.20260918.1`, which matches the installed binary `workerd@1.20260918.1`                                | [`679c09e5`](https://github.com/cloudflare/workerd/tree/679c09e5eea0af8a04062e1875e99c75af532e3b)                                                                                                                         |

Paths written as `VENDOR/engine.ts:NNN` are relative to the `VENDOR` directory, and line numbers
refer to the installed files. Workerd links are pinned to `679c09e5`.

---

## 1. The big picture: workerd has no Workflows engine

**[code]** workerd does not implement Workflows. Two things are all it provides:

1. **A `WorkflowEntrypoint` base class.** It only sets `this.ctx` and `this.env`
   ([`workers-module.h:54-72`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/api/workers-module.h#L54-L72),
   [`workers-module.c++:40-52`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/api/workers-module.c%2B%2B#L40-L52)).
   workerd records a class exported from a Worker as a workflow class when it extends this base
   ([`worker.c++:2150-2151`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/io/worker.c%2B%2B#L2150-L2151)).
   It then serves that class exactly like a stateless `WorkerEntrypoint`: "Workflow classes are
   treated as stateless entrypoints for runtime purposes"
   ([`server.c++:3406-3416`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/server/server.c%2B%2B#L3406-L3416),
   [`server.c++:5910-5919`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/server/server.c%2B%2B#L5910-L5919),
   [`worker.c++:2482-2483`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/io/worker.c%2B%2B#L2482-L2483)).
   As a result, `run(event, step)` is just a JS-RPC method call that the engine makes into a fresh
   stateless entrypoint instance.
2. **A thin binding wrapper, `cloudflare-internal:workflows-api`**
   ([`src/cloudflare/internal/workflows-api.ts`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/cloudflare/internal/workflows-api.ts)).
   It forwards every call to an inner `fetcher` binding by instance id: `create`, `getInstance`,
   `sendEvent(id, …)`, `status(id)`, and so on (lines 19-46, 83-91, 108-122). In production that
   fetcher is Cloudflare's closed-source Workflows service. The binding is declared in capnp as a
   `wrapped` binding, `WrappedBinding { moduleName, entrypoint, innerBindings }`
   ([`workerd.capnp:600-618`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/server/workerd.capnp#L600-L618)).
   workerd's own test wires this module to a mock service
   ([`workflows-api-test.wd-test`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/cloudflare/internal/test/workflows/workflows-api-test.wd-test)).

**[code]** Locally, the engine is the TypeScript package `workflows-shared` from workers-sdk.
Miniflare uses it, and Alchemy vendors it as `VENDOR`. It runs as ordinary Worker code on top of
workerd: an `Engine` Durable Object plus a `WorkflowBinding` `WorkerEntrypoint`
(`VENDOR/local-binding-worker.ts:3-4`).

**[prod-claim]** Production has the same shape: "Every workflow instance is an Engine behind the
scenes, and every Engine is an SQLite-backed Durable Object". The Engine "is responsible for starting
up the user's workflow entry point, executing the steps on behalf of the user", and step callbacks
switch "over to the Engine" via JS RPC
([Building Workflows](https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/)).
**[inference]** The local engine is plausibly a port or simplification of the production engine.
Comments such as "Match the production engine" (`VENDOR/engine.ts:1290`) and "same as production
behaviour" (`VENDOR/engine.ts:1518`) suggest so. Several production mechanisms are visibly stubbed
out locally (alarms, wakers, queueing, grace-period eviction; see section 9).

### Local topology as Alchemy configures it

**[code]** `ALCHEMY/Workflows.ts:122-179` (`makeEngineService`) emits one workerd service per
workflow, named `workflows:<workflowName>`, with the following configuration:

- Modules: the vendored `Engine` and `WorkflowBinding` (`ALCHEMY/binding.worker.ts:3-6`).
- One Durable Object namespace, `Engine`, with `enableSql: true`, `uniqueKey` set to the workflow
  name, and **`preventEviction: true`** (`Workflows.ts:136-143`). The workerd docs for that flag
  read: "By default, Durable Objects are evicted after 10 seconds of inactivity… Some applications
  may want to keep their Durable Objects pinned to memory forever… only supported in Workerd;
  production Durable Objects cannot toggle eviction"
  ([`workerd.capnp:669-674`](https://github.com/cloudflare/workerd/blob/679c09e5eea0af8a04062e1875e99c75af532e3b/src/workerd/server/workerd.capnp#L669-L674)).
- Storage on local disk under `<storage>/workflows` (`Workflows.ts:41-67, 144-146`).
- Bindings:
  - `ENGINE` (the DO namespace).
  - `USER_WORKFLOW`, a service binding to the user worker with `entrypoint: <className>`.
  - `BINDING_NAME` and `WORKFLOW_NAME`.
  - `STEP_LIMIT`, when configured.

  These are at `Workflows.ts:147-177`. Alchemy does not pass `MINIFLARE_LOOPBACK`, so every
  persistence-deletion loopback path in `binding.ts` and `engine.ts` is a no-op here.

- The user-facing binding is a `wrapped` binding around the `cloudflare-runtime:workflows-wrapped-binding`
  module. Its inner `binding` points at `workflows:<name>`, entrypoint `WorkflowBinding`
  (`Workflows.ts:244-258`).

**[code]** Miniflare's plugin generates the same shape, with `preventEviction: true`, `enableSql`,
and `USER_WORKFLOW` set to the user's export. Unlike Alchemy, it also adds the loopback binding
(miniflare `index.ts:233-295`).

```
user Worker ──env.WF (wrapped-binding.worker.ts)──► WorkflowBinding (WorkerEntrypoint, service workflows:<name>)
                                                       │ ENGINE.idFromName(instanceId)
                                                       ▼
                                                 Engine DO (one per instance id, SQLite, preventEviction)
                                                       │ USER_WORKFLOW.run(event, step: Context RpcTarget)
                                                       ▼
                                            user Worker's WorkflowEntrypoint (stateless entrypoint)
                                                       │ step.do(name, cb) ── RPC ──► Context.do (in Engine)
                                                       ◄── RPC: Engine invokes cb (a stub) ──┘
```

---

## 2. The `create()` path end to end (local)

1. **Consumer wrapper.** `ALCHEMY/wrapped-binding.worker.ts:18-22` awaits `binding.create(options)`
   over RPC and returns an `InstanceImpl` that holds only the id. **[code]**
2. **`WorkflowBinding.create`** (`VENDOR/binding.ts:190-251`): **[code]**
   - It validates the id (`196-198`) and calls `waitForPersistedInstanceDelete`. That call returns
     immediately when there is no `MINIFLARE_LOOPBACK`, which is always the case under Alchemy
     (`42-45`).
   - It gets the stub with `ENGINE.idFromName(id)` (`201-202`).
   - It applies any active test-introspection operations (`203-211`).
   - It calls **`stub.init(...)` without awaiting it** and passes the promise to
     `this.ctx.waitUntil` (`214-246`). The code comment reads: "create() should queue and return
     immediately".
   - It returns `{ id }` (`248-250`).

   **So locally, `create()` resolves before the Engine has persisted anything.** It also does not
   check for duplicate ids. Upstream HEAD adds a duplicate-id check via `stub.hasInstance()`; see
   section 10.

3. **`Engine.init`** (`VENDOR/engine.ts:1472-1634`) runs inside the DO. In order, it: **[code]**
   1. Lazily constructs a `TimePriorityQueue`, which reads the whole `priority_queue` SQL table
      (`1479-1491`; `lib/timePriorityQueue.ts:34-38, 189-223`).
   2. Returns early if `this.isRunning` is already set (`1493-1495`). This makes repeated `init`
      calls idempotent within a single lifetime.
   3. Pops past PQ entries and calls `handleNextAlarm()` (`1497-1498`). `handleNextAlarm` is a stub
      with its body commented out, so locally **no Durable Object alarm is ever set**
      (`lib/timePriorityQueue.ts:138-152`).
   4. Calls `getStatus()` and returns if the status is Errored, Terminated, Complete or Paused. A
      status of WaitingForPause becomes Paused (`1505-1523`).
   5. On the first lifetime only, writes `INSTANCE_METADATA` and logs `WORKFLOW_QUEUED` and
      `WORKFLOW_START` (`1525-1544`).
   6. Calls `restoreEventMap()`, which runs a `blockConcurrencyWhile` plus a `storage.list` over the
      `EVENT_MAP` prefix (`1547`, `1145-1160`).
   7. Creates `new Context(this, this.ctx)`, which is the `step` object and an `RpcTarget`
      (`1549`).
   8. Sets `isRunning = true` and calls `setStatus(Running)` **fire-and-forget** inside a storage
      transaction (`1551-1560`).
   9. **`await this.env.USER_WORKFLOW.run(event, stubStep)`** (`1561-1563`). This is a JS-RPC call
      into the user's `WorkflowEntrypoint`. It stays pending for the whole life of the run.
   10. When `run` returns, stores `WORKFLOW_OUTPUT`, logs `WORKFLOW_SUCCESS`, and sets Complete
       (`1564-1577`). When it throws, runs rollbacks, then logs `WORKFLOW_FAILURE` and sets Errored.
       A `NonRetryableError` also aborts the DO (`1578-1629`).

**[code]** Between `create()` and `run()` there is **no queue, no alarm, and no timer**. The only
gaps are these:

- the RPC hop from the wrapped binding to `WorkflowBinding`;
- the `waitUntil`-detached RPC to the DO;
- roughly a dozen local SQLite and KV operations inside `init`;
- one service-binding RPC into the user worker.

The "TODO (WOR-78): We currently don't have a queue mechanism" comment at `engine.ts:1535` confirms
that local mode has no queue.

**[code]** The first `step.do` adds its own fixed overhead before the user callback runs
(`VENDOR/context.ts:241-717`):

- `computeHash(name)`, a SHA-1 over `crypto.subtle` (`lib/cache.ts:3-10`);
- a 5-key `storage.get` (`354-360`) and a `put` of the step config (`439-441`);
- semaphore `acquire`;
- `writeLog(STEP_START)` and `writeLog(ATTEMPT_START)`, which are SQL inserts;
- a `get` of `INSTANCE_METADATA`;
- a `put` of the step state;
- about five `storage.get`s for test modifiers (`607-634`);
- a PQ `add` for the step timeout, which runs inside a `storage.transaction` (`576-580`);
- **an RPC back into the user worker to invoke the callback stub** (`709-716`).

**[prod-claim]** In production, `create()` "Store[s] only necessary metadata (instance payload,
creation date) onto its own _Engine_". The control plane then "informs itself of the Engine's
existence through background operations", and Workflows "set[s] an 'alarm' on _Engine_ in the
creation hot-path. That way, if the background task does not finish, the alarm **ensures** that the
instance will begin". "When an instance is created, it is randomly assigned to one of the
_SousChefs_… the _SousChef_ makes a request to _Account_ to trigger that instance. Either a slot is
granted, or the instance is queued." Communication between SousChefs and the Account "happens on a
periodic cycle, once per second". Source: [Workflows V2](https://blog.cloudflare.com/workflows-v2/).

**[inference]** The production create-to-first-step path therefore contains things that are
entirely absent locally:

- a durable write to a remote Engine DO before `create()` resolves;
- a background control-plane hop;
- concurrency-slot leasing with a periodic once-per-second cycle;
- a possible alarm-driven start;
- a cold Engine DO and a cold user isolate.

The once-per-second cycle alone could plausibly account for hundreds of milliseconds of variance in
the thesis's 800 ms to 1.5 s window. This is unverified.

---

## 3. `step.do`: caching, identity and replay

**Identity.** **[code]**

- The step key is `cacheKey = sha1(name) + "-" + count`. `count` is a per-`Context` counter keyed by
  `"run-" + name`, 1-indexed, and incremented on each call (`context.ts:201-208, 341-344`).
- Identity is therefore **name plus occurrence index within this execution of `run()`**. The step
  config and the closure body are not part of it.
- A new `Context` is created on every `init` (`engine.ts:1549`), so counters restart from 0 on every
  replay.

**Storage keys** (`context.ts:347-352`). All of these live in the Engine DO's KV storage: **[code]**

| Key                    | Contents                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- |
| `${cacheKey}-value`    | `{ value }` wrapper, so that `undefined` can be stored (`719-721`, `650-651`) |
| `${cacheKey}-config`   | resolved config (`441`)                                                       |
| `${cacheKey}-error`    | final error after retries are exhausted (`1019`)                              |
| `${cacheKey}-metadata` | `{ attemptedCount }`                                                          |
| stream meta and chunks | `streaming_step_chunks` SQL table (`engine.ts:453-459`)                       |

**Cache lookup** (`context.ts:354-437`). **[code]**

- If a complete stream output exists, it is replayed.
- Otherwise, if `${cacheKey}-value` exists, the stored value is returned without calling the
  callback.
- Otherwise, if `${cacheKey}-error` exists, it is thrown.
- One quirk: the check is `if (maybeResult)` (`402`), so a stored `{ value: undefined }` wrapper
  still counts as a hit, because the wrapper object is truthy.

**Replay model.** **[code]** There is no checkpointing of the JS stack. After any loss of in-memory
state, `init` calls `USER_WORKFLOW.run(event, step)` **from the top** again. Every completed
`step.do` returns its cached value, and execution continues at the first uncached step. The SQL
`states` table (`engine.ts:445-452`) is an append-only event log used for status, logs and
subscriptions. Replay does not use it, except for a dead path: `readLogsFromStep` always returns
`[]` (`engine.ts:587-589`), so the "engine died mid-attempt" recovery branch at `context.ts:469-502`
never fires locally.

**[prod-claim]** "Steps pending if a Durable Object is evicted… get rerun on the next lifetime of the
Engine (with its cache from the previous lifetime hydrated) that is triggered by an alarm set with
the timestamp of the next expected state transition"
([Building Workflows](https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/)).

**Step limit.** **[code]** `DEFAULT_STEP_LIMIT = 10_000` (`engine.ts:127`). It can be overridden
with the `STEP_LIMIT` binding (`engine.ts:429`). The limit is counted per `Context` lifetime and
covers `do` calls only, not sleeps or waits (`context.ts:288-297`).

---

## 4. Retries, backoff and timeouts

**[code]** Default step config (`context.ts:132-139`): `retries: { limit: 5, delay: 1000,
backoff: "exponential" }` and `timeout: "10 minutes"`. `DEFAULT_RETRY_DELAY_MS = 1000` and
`DELAY_FUNCTION_TIMEOUT_MS = 5 s` (`lib/delay.ts:11-13`).

**[code]** Backoff (`lib/retries.ts:36-47`):

- exponential: `base * 2^(attempt-1)`;
- linear: `base * attempt`;
- constant: `base`.

`willRetry = attemptedCount <= limit` (`context.ts:870`), so `limit: 5` means up to 6 attempts.

**[code]** Each attempt races the callback against `scheduler.wait(timeout)` (`context.ts:569-592,
708-716`). A retry is a `scheduler.wait(delay)` raced against the pause signal, followed by a
recursive `doWrapper` (`977-996`).

Both waits are recorded in the `priority_queue` table as `timeout` and `retry` entries. That table
is append-only: removal inserts an `action=0` row (`lib/timePriorityQueue.ts:225-262`). The purpose
is that a new lifetime can resume a partially elapsed wait (`context.ts:526-549`).

**[code]** `NonRetryableError` is detected by `name` or by a message prefix and is never retried
(`context.ts:840-866`). At the workflow level it marks the instance Errored and aborts the DO
(`engine.ts:1593-1607`).

**[code]** Vendored-copy bug: the step timeout's `scheduler.wait` is not cancelled when a step
finishes, so a native timer lingers until the original deadline (10 minutes by default). Upstream
fixed this after the vendored commit; see section 10.

---

## 5. `sleep`, `sleepUntil` and alarms

**[code]** `sleep(name, duration)` (`context.ts:1057-1142`):

- Its key is `sha1(name + duration) + "-" + count`, so **changing the duration changes the step
  identity**.
- It writes `SLEEP_START`, stores `${cacheKey}-value = true` **before** sleeping, adds a PQ `sleep`
  entry, and then `scheduler.wait(duration)` raced against the pause signal.
- On replay, a cached sleep with a live PQ entry waits only the remaining time (`1083-1100`).
- `sleepUntil` converts to a relative `sleep` and throws for timestamps in the past (`1144-1160`).

**[code]** **There are no Durable Object alarms in local mode.** The `Engine` class defines no
`alarm()` handler. `grep alarm` over `VENDOR` finds only comments. `handleNextAlarm` is a stub
(`lib/timePriorityQueue.ts:138-152`). The grace-period handler, which in production would set the
next alarm and then evict the engine, has its abort commented out (`lib/gracePeriodSemaphore.ts:162-171`;
`ENGINE_TIMEOUT = 5 minutes` at line 7). Every local wait (sleep, retry, step timeout,
`waitForEvent` timeout) is therefore a live in-isolate `scheduler.wait` timer. Locally this works
only because the DO is never evicted (`preventEviction: true`).

**[prod-claim]** Production uses "a combination of using `scheduler.wait()` and Durable Objects
alarms", and alarms wake the Engine "at a time in the future"
([Building Workflows](https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/)).
Alarms have "an at-least-once execution model, with automatic retries built in"
([Workflows V2](https://blog.cloudflare.com/workflows-v2/)).

**[inference]** The locally inert `GracePeriodSemaphore` hints at the production policy. Once no step
is running (the counter drops to 0), a 5-minute grace period starts. If nothing restarts a step
before it ends, the engine sets its next alarm and is evicted. If that inference is right, an Engine
parked in `waitForEvent` stays resident for up to ~5 minutes after its last step. After that, waking
it requires re-instantiating the Engine DO, re-running `init`, and replaying `run()` in a possibly
cold user isolate. This is unverified and is the single most important thing for the benchmark to
measure; see section 11.

---

## 6. `waitForEvent` and `sendEvent`

### Waiting side: `Context.waitForEvent` (`context.ts:1162-1342`) [code]

- **Default timeout is `"24 hours"`** when none is given (`1173-1175`).
- The counter is keyed by `"waitForEvent-" + name`, and `cacheKey = sha1(`${name}-${count}`) + "-" +
  count` (`1177-1180`). The step name and position determine identity. **The event `type` is not
  part of the identity.**
- If `${cacheKey}-value` is cached, the stored event is returned immediately (`1190-1207`). This is
  how a replay passes a wait that has already completed.
- If `${cacheKey}-error` is cached, it is thrown (`1208-1215`).
- On the first entry, it writes `WAIT_START` and the `${cacheKey}-pending` marker (`1217-1225`).
- If a PQ `timeout` entry for this key existed and has elapsed or been removed, it throws
  `WorkflowTimeoutError` (`1227-1251`).
- **Delivery uses an in-memory structure.** `eventPromise` first shifts a buffered event from
  `engine.eventMap.get(type)`; failing that, it pushes `[cacheKey, resolve]` onto
  `engine.waiters.get(type)` (`1281-1296`).
- That promise is raced against the timeout timer and the pause signal (`1298-1325`). On success it
  logs `WAIT_COMPLETE` and stores `${cacheKey}-value = event` (`1333-1341`).

### Sending side [code]

- **Consumer wrapper.** `ALCHEMY/wrapped-binding.worker.ts:128-131` first calls
  `binding.get(id)` (`91-93`).
- **`WorkflowBinding.get`** (`binding.ts:253-269`) builds a `WorkflowHandle` and **calls
  `handle.status()`**. That call does an RPC `stub.getStatus()` plus an RPC `stub.readLogs()`, and
  `readLogs()` selects and JSON-parses **every row of the instance's `states` log**
  (`binding.ts:530-577`, `engine.ts:673-714`).
- Only then does `WorkflowHandle.sendEvent` call `stub.receiveEvent({ payload, type, timestamp })`
  (`binding.ts:584-590`).
- **`Engine.receiveEvent`** (`engine.ts:1162-1215`):
  1. It appends the event to `eventMap[type]` and **persists the whole event map**: a
     `blockConcurrencyWhile` plus a `storage.put` of keys `EVENT_MAP\n<type>\n<i>`
     (`1169-1173`, `1131-1143`).
  2. If `isRunning` is set and a waiter exists for `type`, it resolves the first waiter (FIFO) and
     shifts the event back out of the **in-memory** map (`1176-1194`). Delivery is a plain
     in-memory promise resolution inside the live DO.
  3. If `isRunning` is set and no waiter exists, the event stays buffered. A later `waitForEvent`
     with the same `type` consumes it. **Events sent before `waitForEvent` is reached are therefore
     buffered.**
  4. If `isRunning` is not set (a new DO lifetime after a restart or a resume), it calls
     `void this.init(...)` from metadata. **That re-runs `run()` from the top**, replaying cached
     steps until it reaches the wait, and `restoreEventMap` hands the event over (`1195-1214`).
- `receiveEvent` returns as soon as the waiter is resolved, so **`sendEvent()` resolves before the
  next step runs**. The benchmark must timestamp the next step from inside the workflow, not from
  the `sendEvent` return.

**[prod-claim]** "You can send an event to a Workflow instance _before_ it reaches the corresponding
`waitForEvent` call, as long as the instance has been created. The event will be buffered…". Other
documented constraints:

- `type` is letters, digits, `-` and `_`, up to 100 characters;
- the timeout ranges from 1 second to 365 days, with a 24-hour default;
- an unhandled timeout fails the instance;
- event payloads are at most 1 MiB.

Sources: [events docs](https://developers.cloudflare.com/workflows/build/events-and-parameters/) and
the [limits page](https://developers.cloudflare.com/workflows/reference/limits/). **[code]** The
local engine does not validate the `type` format.

**[prod-claim]** "Waiting instances… do not count towards instance concurrency limits", and the limit
is 50,000 concurrent "running" instances on Paid
([limits](https://developers.cloudflare.com/workflows/reference/limits/)). V2 also states "if an
instance wakes up, it should be prioritized for a slot over a newly created instance"
([Workflows V2](https://blog.cloudflare.com/workflows-v2/)). **[inference]** A parked instance
therefore needs a concurrency slot again when it is woken. The wake path presumably goes through
slot granting, though with priority over new creates.

### Pitfalls found in the local code [code; impact is inference]

- **Consumed events are never deleted from storage.** `storeEventMap` writes indexes 0..n-1 of the
  current in-memory queue. After delivery, only the in-memory copy is shifted (`engine.ts:1188-1190`,
  `context.ts:1286-1289`). After a resume or a DO restart, `restoreEventMap` reloads an
  already-consumed event. A replayed wait is unaffected because it returns its cached `-value`.
  However, a _second_ `waitForEvent` on the same `type` in the same instance could receive the
  stale event. A one-shot pool instance that waits once is unaffected.
- **The status stays `running` while parked.** `InstanceStatus.Waiting` (7) exists and `setStatus`
  logs it (`engine.ts:899-901`), but nothing in the vendored engine ever sets it. Local
  `status()` therefore reports `running` for a parked instance. **[inference]** Production
  probably reports `waiting`, because the status exists in the public enum for that purpose. Pool
  code must not rely on status to detect "parked". The `subscribe()` stream does emit a
  `wait_started` event (`engine.ts:323-329`) and is the code-supported readiness signal.
- **`create()` followed immediately by `sendEvent()` can race.** `create()` returns before `init`
  has written `INSTANCE_METADATA`, and `sendEvent` → `get` → `getStatus` throws "Engine was never
  started" when metadata is missing (`engine.ts:803-810`). That error surfaces as
  `instance.not_found` (`binding.ts:262-266`). **[inference]** In practice the DO probably
  processes `init` first, but nothing in the code orders the two calls.
- **The `waitForEvent` timeout timer is not cancelled when the event arrives.** The 24-hour
  `scheduler.wait` and its PQ `timeout` entry survive. Upstream fixed this at HEAD; see section 10.

---

## 7. Status transitions, pause, resume, terminate and restart

**[code]** The status enum (`instance.ts:28-37`):

| Value | Status          |
| ----- | --------------- |
| 0     | Queued          |
| 1     | Running         |
| 2     | Paused          |
| 3     | Errored         |
| 4     | Terminated      |
| 5     | Complete        |
| 6     | WaitingForPause |
| 7     | Waiting         |

The status lives in KV `ENGINE_STATUS`. A missing value means Queued (`engine.ts:817-823`). Each
change writes a `WORKFLOW_*` log row and wakes any `waitForStatus` and subscription waiters
(`870-907`).

Local transitions **[code]**:

- **Queued → Running.** Set fire-and-forget just before `run()` (`engine.ts:1551-1560`).
- **Running → Complete or Errored.** Set when `run()` settles (`1564-1629`).
- **`pause`.** Allowed only from Running or Waiting. The engine sets WaitingForPause, then waits
  until the semaphore shows no step in flight (`gracePeriodSemaphore.ts:66-98`). After that it
  writes `PAUSE_DATETIME`, sets Paused, and aborts `pauseController` (`engine.ts:1358-1388`). That
  abort interrupts sleeps, retries and `waitForEvent` (`context.ts:1121-1135, 1298-1330`), and the
  run unwinds with the `USER_PAUSE` abort error. `#checkForPendingPause` converts WaitingForPause
  into Paused at the next step boundary (`context.ts:176-199, 1050-1052`).
- **`resume`.** From WaitingForPause it cancels the pending pause (`engine.ts:1238-1241`). From
  Paused it shifts all PQ timers by the paused duration, resets the in-memory waiters and event
  map, and calls `init`. That **replays `run()` from the top** (`engine.ts:1431-1470`).
- **`terminate`.** Rejected in terminal states. It can optionally run rollbacks first (by replaying
  `run()` in a "replay" phase to re-register rollback closures, `1274-1297`). It then logs
  `WORKFLOW_TERMINATED`, sets Terminated, and **`ctx.abort()`s the DO** (`1247-1260, 1299-1331`,
  `1112-1120`).
- **`restart`.** `ctx.abort()`s the DO (`1390-1394`). The binding then gets a fresh stub and calls
  `attemptRestart`. That wipes status and the cached step state, either entirely or from a given
  step via `lib/restart.ts`, then re-logs QUEUED/START and calls `init` (`1396-1429`,
  `binding.ts:515-528`).
- **`delete`.** Calls `storage.deleteAll()` and then aborts (`engine.ts:1334-1356`).

**[code]** One semaphore quirk: `latestGracePeriodTimestamp` is module-global
(`gracePeriodSemaphore.ts:9`). It is therefore shared by every Engine DO in the same isolate.
Upstream HEAD moved it onto the instance. This matters only to the inert grace-period handler.

---

## 8. Engine DO eviction and isolate restarts

**[code]** These are the local mechanisms that bear on eviction:

- `preventEviction: true` means the workerd runtime never evicts an Engine for inactivity
  (`ALCHEMY/Workflows.ts:141`).
- The `init` RPC, and through it the `USER_WORKFLOW.run` RPC, stays pending for the entire life of a
  run. The user-side `run()` invocation is therefore also held open. **[inference]** A parked local
  instance really is a suspended JS promise in two live isolates.
- In-memory-only state includes `isRunning`, `waiters`, `eventMap`, `priorityQueue` (which is
  rebuilt from SQL), `rollbackRegistry` ("RPC stubs, dead across DO restarts", `engine.ts:421-422`),
  and the step counters.
- After a process or isolate restart (for example a `vite`/`alchemy dev` reload), nothing re-runs
  `init` for existing instances. There are no alarms and no startup scan. An instance that was
  sleeping or retrying is therefore **stuck** until something calls `init`. Only `receiveEvent`
  (`engine.ts:1195-1214`) and `attemptResume`/`attemptRestart` call it; `getStatus` does not.
  **[inference]** For a parked pool instance, the first `sendEvent` after a restart revives it by
  replay. A sleeping instance, however, is never revived locally.
- **[code]** `abort()` calls `storage.sync()`, disposes the semaphore, aborts the engine controller,
  then calls `ctx.abort(reason)` (`engine.ts:1112-1120`). Callers swallow the expected abort errors
  (`binding.ts:478-528`).

**[prod-claim]** Durable Objects in production are evicted, and the engine relies on alarms to come
back; see the quotes in section 5. **[inference]** Production waits are therefore not resident, and
resuming one costs at least a DO wake plus an `init` replay.

---

## 9. Concurrency, constants and timers in the code

| Constant                        | Value                                                     | Where                                    |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `DEFAULT_STEP_LIMIT`            | 10,000                                                    | `engine.ts:127`                          |
| default retries                 | limit 5, delay 1000 ms, exponential                       | `context.ts:132-139`                     |
| default step timeout            | 10 minutes                                                | `context.ts:138`                         |
| default `waitForEvent` timeout  | 24 hours                                                  | `context.ts:1173-1175`                   |
| `ENGINE_TIMEOUT` (grace period) | 5 minutes, handler inert locally                          | `lib/gracePeriodSemaphore.ts:7, 142-177` |
| `DELAY_FUNCTION_TIMEOUT_MS`     | 5 s                                                       | `lib/delay.ts:13`                        |
| max instance id                 | 100 chars, `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`                 | `lib/validators.ts:12, 18`               |
| max step name                   | 256 chars                                                 | `lib/validators.ts:16`                   |
| `deleteBatch` max               | 100                                                       | `binding.ts:315-320`                     |
| `createBatch`                   | `Promise.all` of `create()`, no size cap in vendored copy | `binding.ts:271-284`                     |

**[code]** There is no concurrency limit, queue or slot system anywhere in the local engine. N
`create()` calls produce N immediately running engines.

**[prod-claim]** Production limits on Paid are as follows. Concurrent running instances: 50,000.
Creation rate: 300 per second per account and 100 per second per workflow. Queued instances:
2,000,000 per workflow. Waiting instances are excluded from concurrency
([limits](https://developers.cloudflare.com/workflows/reference/limits/),
[V2](https://blog.cloudflare.com/workflows-v2/)). The V1 limits were "4,500 concurrency slots and
100 instance creations per 10 seconds".

---

## 10. Divergence: vendored copy vs upstream HEAD

**[code]** The Alchemy-specific changes are cosmetic: `Array<T>` syntax, Effect Schema validators in
place of Zod, and `.ts` import extensions (header comments in each file). The upstream commits on
`packages/workflows-shared` made after `f9e7727d` that are relevant here:

- [`e6f76636`](https://github.com/cloudflare/workers-sdk/commit/e6f76636249eeca2407a28f3e0e786c4db24ab19)
  "Cancel completed step timeout timers" (#15939).
  - Step-timeout, retry and sleep waits become a signal-aware `schedulerWait`.
  - `waitForEvent` now cancels its timeout timer in a `finally` block and removes the PQ `timeout`
    entry on success (upstream `context.ts:1429-1537`).
  - Effect on the vendored copy: every parked or dispatched instance leaves a 24-hour native timer
    behind. **[inference]** This is harmless for correctness but leaks timers for a large local
    pool.
- [`940c6925`](https://github.com/cloudflare/workers-sdk/commit/940c6925b887faa4f43eccc957766385f6cc2d47)
  "Emulate deterministic-ID uniqueness" (#14847).
  - `create()` with an explicit id now throws when the instance exists, via the new
    `Engine.hasInstance()` (upstream `binding.ts:273-300`, `engine.ts:1655-1658`).
  - The vendored copy silently re-`init`s instead, which is a no-op when the instance is running.
- [`464a5824`](https://github.com/cloudflare/workers-sdk/commit/464a582442ad6872edf1d52107b1a7b68b5e606f)
  Object-form `createBatch({ count, params } | { instances })`.
  - The count form has a cap of 100 and returns a `{ created, errors }` result.
  - This is relevant for batch refill.
- [`4c2993b8`](https://github.com/cloudflare/workers-sdk/commit/4c2993b898c8df4ea6799897803c2c5ef18c5847)
  Workflows on `ctx.exports`.
  - The Engine can take `workflowClass` and `workflowName` from `ctx.props` instead of
    `USER_WORKFLOW` (upstream `engine.ts:85-95, 1418, 1751`).
  - `WorkflowBinding` gains id-addressed methods (`sendEvent(id, …)`, `status(id)`, …) that match
    workerd's `workflows-api.ts` `Fetcher` interface.
  - **[code]** workerd `v1.20260918.1` contains no such engine support (its only workflow code is
    listed in section 1), so this path is irrelevant to the installed runtime.

---

## 11. Why local timing will differ from production

The following hold locally:

1. **[code]** There is no queue, slot leasing, control-plane hop or alarm between `create()` and
   `run()` (section 2). Production has all of them **[prod-claim]**.
2. **[code]** `create()` resolves before any durable write. **[prod-claim]** Production writes
   metadata to the Engine in the hot path.
3. **[code]** The Engine DO is pinned in memory (`preventEviction`), and the parked `run()` is a live
   suspended promise. `sendEvent` is an in-memory `resolve()`. **[inference]** Production evicts
   idle Engines, probably after a ~5-minute grace period, so a production wake likely includes a
   DO cold start, an `init`, a full `run()` replay through cached steps, and possibly a cold
   user-Worker isolate.
4. **[code]** Local `sendEvent` costs an extra `get()` → `status()` → `readLogs()` round trip before
   `receiveEvent` (section 6). Production `sendEvent` is a single `fetcher.sendEvent(id, …)` RPC
   (workerd `workflows-api.ts:83-91`). Local dispatch overhead is therefore _inflated_ in one
   respect, while the resident engine makes it _deflated_ in another.
5. **[code]** All storage is local SQLite on disk. Production storage is replicated, and an
   output-gated write commits only after replication. **[inference]** Every local `put` and SQL
   insert is cheaper.
6. **[inference]** All services share one workerd process on one machine. There is no network,
   placement or location effect, and none of the per-colo variance that the V2 post's "one network
   hop" claim implies.

**Conclusion [inference]:** local numbers can neither confirm nor refute the thesis, which matches
AGENTS.md's rule that only deployed measurements count. Local runs are useful only to check that the
benchmark harness works.

---

## 12. Implications for the pre-started pool and the benchmark

**Pool design.** These are mostly inferences.

- **Parking is code-supported.** A first-step `waitForEvent` writes `WAIT_START`, stores a
  `-pending` marker and leaves a waiter in memory. The event payload becomes the cached result of
  that wait. On any replay, the wait returns the cached event, so the dispatched payload is durable
  once `WAIT_COMPLETE` is written. **[code]**
- **Readiness must not come from `status()`.** Locally a parked instance reports `running`
  (section 6). Use `subscribe({ filter: ["wait_started"] })` or the step logs instead. **[code]**
  Alternatively, rely on event buffering: an instance that has merely been created can already
  accept the event. **[prod-claim and code]** The pool could therefore count an instance as
  "available" as soon as `create()` resolves. It would still pay the start cost on dispatch, so
  `available` should probably mean _observed parked_.
- **The `waitForEvent` timeout bounds pool residency.** The default is 24 hours, and an unhandled
  timeout fails the instance. The pool should set an explicit long timeout (up to 365 days in
  production, **[prod-claim]**) or catch the timeout and exit cleanly. It should also treat
  timed-out instances as lost inventory.
- **Use one waiter per event `type` per instance, and a unique `type` if possible.** Delivery is
  FIFO by `type`, not by step name (`engine.ts:1178-1186`). The stale-event bug in section 6 also
  bites only when the same type is awaited twice.
- **Retention.** Every pool instance, whether parked, dispatched or failed, consumes an Engine DO and
  stored state until its retention expires (30 days on Paid **[prod-claim]**). Parked instances do
  not count toward the concurrency limit **[prod-claim]**, but a woken one competes for a slot with
  priority over new creates **[prod-claim]**.
- **Refill.** Production creation is rate-limited (300/s per account, 100/s per workflow
  **[prod-claim]**). Upstream's object-form `createBatch({ count })` (max 100) fits the
  low-water-mark batch refill. That form is not in the vendored copy, and production support should
  be confirmed in the Workers API docs.

**Benchmark design.**

- **Timestamp three moments for the cold path:**
  - A: just before `create()`;
  - B: `create()` resolved;
  - C: the first line inside the first `step.do` callback.

  **Timestamp three moments for the dispatch path:**
  - A′: just before `sendEvent()`;
  - B′: `sendEvent()` resolved;
  - C′: the first line inside the step after `waitForEvent`.

  Locally, B and B′ both precede any engine work on the user's behalf, so B→C and B′→C′ are the
  interesting intervals. **[code]**

- **Clock caveat [inference from platform behavior, not from this code]:** inside Workers,
  `Date.now()` advances only across I/O. C is also observed in a different isolate, and possibly on
  a different machine, from A. Measure end-to-end with one observer if possible: the step writes
  its marker to a DO or KV and the client polls, or the step calls back to a timestamping endpoint.
  Alternatively, record both the client-side and the in-step timestamps and report their
  difference with a skew bound.
- **Record and do not discard replay work.** On wake, production likely re-runs `run()` from the
  top. Keep the code before the parking wait minimal (no `step.do` before it) so replay is cheap.
  The benchmark should also include a variant with N cached steps before the wait to expose replay
  cost.
- **Measure parked-age as a variable.** Dispatch to instances parked for about 10 s, 1 min, 5 min,
  10 min and 1 h. If the 5-minute grace-period inference is right, latency should step up beyond
  about 5 minutes once the Engine has been evicted. That step change is the direct test of whether
  "pre-started" beats `create()`.
- **Run the cold and dispatch paths interleaved in the same run and deployment,** with enough
  samples per age bucket for stable p99 (per AGENTS.md).
- **Treat local runs as harness validation only** (section 11).

---

## 13. Open questions

1. What is the production Engine eviction policy for an instance parked in `waitForEvent`? Is the
   5-minute `ENGINE_TIMEOUT` grace period real in production? This can only be answered by
   measurement; see the parked-age sweep above.
2. Does production `sendEvent` to a parked or evicted instance replay `run()` from the start, as
   the local engine does on a new lifetime? Or does production keep some state that avoids a full
   replay?
3. Does a woken instance wait on Gatekeeper/SousChef slot granting, including the once-per-second
   cycle? How large is that delay when the account is far below its concurrency limit?
4. Does production `create()` resolve after the Engine metadata write, or earlier? Is the first
   `run()` triggered by the background task or by the creation-time alarm in the common case?
5. Does production report `waiting` for an instance parked in `waitForEvent`, and `running`
   immediately after `sendEvent`?
6. Is production `sendEvent` acknowledged after the event is durably stored on the Engine, or
   earlier? Is the event-buffering guarantee affected by the stale-event behavior seen locally?
7. Is the user-Worker isolate reused between the parking `run()` invocation and the wake
   invocation? Does placement put the Engine DO and the user Worker in the same colo?
8. Is object-form `createBatch({ count })` available in production with the installed workerd and
   `@cloudflare/workers-types`, and what is its per-call latency compared with N parallel
   `create()` calls?
9. Does the vendored engine leak a 24-hour timer per completed `waitForEvent` (section 10)? Does
   that degrade a large local pool? This could be checked by upgrading the vendored copy or by
   observing workerd's memory use.
10. Does the `waitUntil`-detached `init` RPC from `WorkflowBinding.create` survive indefinitely in
    workerd, given that the binding's request context ends when `create()` returns? This is not
    verified. The DO side keeps running regardless, because `preventEviction` is set and DO-side
    execution is not tied to the caller.
