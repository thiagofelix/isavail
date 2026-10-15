# Alchemy v2 Cloudflare Workflows: source-grounded reference

Researched 2026-10-07 against the installed packages. The installed source is the authority here.
Online docs and training data for these pre-1.0 packages are not.

| Package                           | Version         | Resolved from `apps/benchmarks`                                                                                |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `alchemy`                         | `2.0.0-beta.81` | `node_modules/alchemy` → `.pnpm/alchemy@2.0.0-beta.81_@effect+platform-node@4.0.1_…/node_modules/alchemy`      |
| `@alchemy.run/cloudflare-runtime` | `2.0.0-beta.81` | `.pnpm/@alchemy.run+cloudflare-runtime@2.0.0-beta.81_…_f3939caf…/node_modules/@alchemy.run/cloudflare-runtime` |
| `effect`                          | `4.0.1`         | `.pnpm/effect@4.0.1/node_modules/effect`                                                                       |
| `@cloudflare/workers-types`       | `5.20261007.1`  | `.pnpm/@cloudflare+workers-types@5.20261007.1/node_modules/@cloudflare/workers-types`                          |

Citation prefixes:

- `alchemy:` means `alchemy/src/…`. Package `exports` resolve types from `lib/*.d.ts` and Bun from
  `src/*.ts`, and `lib` is compiled from `src`.
- `runtime:` means `@alchemy.run/cloudflare-runtime/src/…`.
- `wt:` means `@cloudflare/workers-types/index.d.ts`.

Two copies of `@alchemy.run/cloudflare-runtime` and two of `@cloudflare/workers-types`
(`5.20261006.1`, `5.20261007.1`) are installed. The citations follow the copies that
`apps/benchmarks` resolves.

## Verdict on the online-doc claims

| Claim (alchemy.run docs)                                                                                                 | Source verdict                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A Workflow is a class `Cloudflare.Workflow<Self>()("Name", Effect.gen(… return Effect.fn(function*(input){…})))`         | **Correct.** There is also a `("Name", props, impl)` overload, and both work without the class wrapper (`alchemy:Cloudflare/Workflows/Workflow.ts:503-547`). No `.make()`/Layer split exists for Workflows, unlike Worker and DurableObject.                                                           |
| Steps are `Cloudflare.Workflows.task(name, effect, {retries, timeout, rollback})`, `sleep`, `sleepUntil`, `waitForEvent` | **Correct, with one omission.** `task` options also accept `rollbackConfig` (`Workflow.ts:80-88`). `waitForEvent` needs an options object `{ type, timeout? }` (`Workflow.ts:104-107`). All four are also re-exported at the root, as `Cloudflare.task` and so on (`alchemy:Cloudflare/index.ts:111`). |
| A Worker binds by `yield*`-ing the class and gets `create`/`get`/`status`                                                | **Partly wrong.** `yield*` binds the Workflow, but the handle exposes `create`, `createBatch`, `get` and `deleteBatch`. **The handle has no `status`.** `status()` belongs to the instance returned by `create`/`get` (`Workflow.ts:427-468`).                                                         |

## 1. Defining a Workflow

### Call shapes (`WorkflowClass`, `alchemy:Cloudflare/Workflows/Workflow.ts:503-547`)

```ts
export interface WorkflowClass extends Effect.Effect<WorkflowHandle, never, WorkflowHandle> {
  ref: typeof WorkflowResource.ref;
  <_Self>(): {
    <Input = unknown, Result = unknown, InitReq = never, E = never>(
      name: string,
      impl: Effect.Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>,
    ): Effect.Effect<WorkflowHandle<Input, Result>, never, Worker | Exclude<InitReq, WorkflowServices>> & {
      new (_: never): WorkflowImpl<Input, Result, E>;
    };
    <Input = unknown, Result = unknown, InitReq = never, E = never>(
      name: string,
      props: WorkflowProps,
      impl: Effect.Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>,
    ): /* same as above */;
  };
  <Params = unknown>(name: string, props?: WorkflowRefProps): WorkflowLike<Params>;   // async-Worker reference form
  <Input, Result, InitReq, E>(name: string, impl: …): Effect.Effect<WorkflowHandle<Input, Result>, never, Worker | …>;
  <Input, Result, InitReq, E>(name: string, props: WorkflowProps, impl: …): Effect.Effect<…>;
}
```

There are four usable forms:

1. **Class, no props**: `class X extends Cloudflare.Workflow<X>()("X", impl) {}`.
2. **Class with `WorkflowProps`**: `Cloudflare.Workflow<X>()("X", { workflowName?, limits?, schedules? }, impl)`.
3. **Plain Effect** (no class): `Cloudflare.Workflow("X", impl)` or `Cloudflare.Workflow("X", props, impl)`.
4. **Reference form for plain async Workers**: `Cloudflare.Workflow<Params>("X", { className?, workflowName?, scriptName?, limits?, schedules? })`.
   It returns a `WorkflowLike` that goes in a Worker's `env` prop. You write the `WorkflowEntrypoint`
   subclass yourself (`Workflow.ts:976-990`, `WorkflowRefProps` at `:277-316`).

The implementation is two-phase, like Workers and DOs. `impl` is an
`Effect<WorkflowImpl<Input, Result, E>, ConfigError, InitReq>`, where:

```ts
// alchemy:Cloudflare/Workflows/Workflow.ts:252-254
export type WorkflowImpl<Input = unknown, Result = unknown, E = never> = (
  input: Input,
) => Effect.Effect<Result, E, WorkflowServices>;
// :234-236
export type WorkflowRunServices = WorkflowEvent | WorkflowStep | WorkerServices | Scope;
export type WorkflowServices = WorkflowRunServices | PlatformServices | RuntimeContext;
```

- The outer `Effect.gen` is the **init phase**, for binding resources and resolving services. It runs
  when the hosting Worker's init runs: at deploy/plan time in Node, and at runtime once per isolate
  build (see §6).
- The returned `Effect.fn(function* (input) { … })` is the **run body**, invoked per `run()`.
  `Input` and `Result` are inferred from it: the scratch type-check showed
  `WorkflowHandle<{ readonly poolId: string }, { requestId: string; … }>`.
- `input` is `event.payload`, passed straight through (`alchemy:Cloudflare/Workflows/WorkflowBridge.ts:81`).
  **Nothing decodes it.** The `Input` type is an unchecked annotation, so decode it with a Schema if
  it crosses a trust boundary.
- Inside the init phase, `yield* Cloudflare.Workflow` (the bare tag, with no call) yields this
  Workflow's own `WorkflowHandle`. `impl` is run with `provideService(WorkflowScope, self)`
  (`Workflow.ts:549-551`, `:1059`). That means a workflow body can `create` sibling instances of its
  own class.

### What happens when the class is evaluated (`Workflow.ts:991-1072`)

A Workflow class is an Effect (`effectClass`, `alchemy:Util/effect.ts:9-27`). The `yield*` must
happen inside a Worker's init, because `Worker` is a requirement. When it runs:

1. `yield* Worker` gets the hosting Worker (`:994`).
2. It registers a `WorkflowResource(name, { workflowName, className: name, scriptName: worker.workerName, limits, schedules })` (`:996-1002`).
   **`className` is always the logical `name`.** So the string passed as `name` becomes the exported
   JS class name and must be a valid identifier. It is not the TypeScript class identifier.
3. It adds a binding `{ type: "workflow", name, workflowName, className: name }` to the Worker
   (`:1009-1018`). **The env binding key is also `name`.**
4. It resolves `env[name]` from `WorkerEnvironment`. The binding is `undefined` during the `plan`
   phase and dies with `Workflow '<name>' not found in env` if it is missing at runtime (`:1022-1033`).
5. It builds the `WorkflowHandle` (`:1035-1057`).
6. It evaluates `impl` and calls `worker.export(name, { kind: "workflow", make })`
   (`:1059-1068`). `make(env)` wraps the body so that `WorkerEnvironment` is provided to each run.

The hosting Worker is whichever Worker `yield*`s the class first. Nothing in the source supports
binding the same Effect-native Workflow class from a second Worker. That path would register a
second `WorkflowResource` with the same logical ID. **This is unverified**; for cross-script use,
use the reference form with `scriptName` (`Workflow.ts:890-912`).

## 2. Step primitives (`alchemy:Cloudflare/Workflows/Workflow.ts:157-217`)

All four require the `WorkflowStep` service, which the bridge provides per run.

```ts
export function task<T, R = never, RollbackReq = never, E = never>(
  name: string,
  effect: Effect.Effect<T, E, R>,
  options?: WorkflowTaskConfig<T, RollbackReq>,
): Effect.Effect<T, E, WorkflowStep | ExcludeWorkflowStepContext<Exclude<R | RollbackReq, Scope>>>;

export const sleep = (name: string, duration: string | number): Effect.Effect<void, never, WorkflowStep>;
export const sleepUntil = (name: string, timestamp: Date | number): Effect.Effect<void, never, WorkflowStep>;
export const waitForEvent = <T = unknown>(
  name: string,
  options: WorkflowWaitForEventOptions,
): Effect.Effect<WorkflowStepEvent<T>, never, WorkflowStep>;
```

The option types (`Workflow.ts:46-117`):

```ts
export type WorkflowBackoff = "constant" | "linear" | "exponential";
export interface WorkflowStepConfig {
  retries?: { limit: number; delay: string | number; backoff?: WorkflowBackoff };
  timeout?: string | number;
}
export interface WorkflowRollbackContext<Output = unknown> {
  error: Error;
  output: Output | undefined;
}
export interface WorkflowTaskConfig<
  Output = unknown,
  RollbackReq = never,
> extends WorkflowStepConfig {
  rollback?: (
    context: WorkflowRollbackContext<Output>,
  ) => Effect.Effect<void, unknown, RollbackReq>;
  rollbackConfig?: WorkflowStepConfig;
}
export interface WorkflowWaitForEventOptions {
  type: string;
  timeout?: string | number;
}
export interface WorkflowStepEvent<Payload = unknown> {
  payload: Payload;
  timestamp: Date;
  type: string;
}
```

Differences from the native `WorkflowStepConfig`:

- Durations are plain `string | number`. Native uses `` `${number} ${label}` | number ``.
- There is no dynamic `delay` function.
- There is no `sensitive` option.
- The rollback context drops native `ctx` and `stepName`.

`step.do` is driven by `WorkflowBridge.wrapWorkflowStep` (`alchemy:Cloudflare/Workflows/WorkflowBridge.ts:139-221`):

- The task Effect runs inside the native `step.do` callback with a fresh `Scope`, and
  `WorkflowStepContext` (`{ step: {name, count}, attempt, config }`) is provided
  (`WorkflowBridge.ts:172-183`; the service is declared at `WorkflowRuntime.ts:35-38`).
- **`Effect.fail`** is encoded into a checksummed `Error` message so that native retries apply. After
  retries are exhausted, the typed `E` is restored in the error channel, including on replay
  (`:232-262`, `:284-332`). Error data is limited to 16 KiB and 64 levels (`:225`, `:357`).
- **`Effect.die` and interrupts** become `NonRetryableError` from `cloudflare:workflows`, which stops
  retries (`:227-230`, `:269-276`).
- `sleep`, `sleepUntil` and `waitForEvent` are `Effect.promise(...)` around the native call
  (`:215-220`), and the public wrappers add `Effect.orDie` (`Workflow.ts:190`, `:202`, `:217`).
  **A `waitForEvent` timeout therefore surfaces as a defect, not a typed error.** If not handled,
  the run throws `Cause.squash(cause)` and the instance errors (`WorkflowBridge.ts:118-121`).
- Config fields left `undefined` are stripped, so they do not override engine defaults
  (`:527-535`).

### `waitForEvent` payload typing

`waitForEvent<T>` is a **type assertion only**. There is no schema parameter. The value is whatever
the engine stored from `sendEvent` (`WorkflowBridge.ts:219-220`). The native constraint
`T extends Rpc.Serializable<T>` (`wt:16637-16643`) is dropped. To obtain a trusted value, call it as
`waitForEvent<unknown>` and decode `event.payload`; the example below does this. The run body also
gets `WorkflowEvent` (`alchemy:Cloudflare/Workflows/WorkflowRuntime.ts:16-30`), whose shape is
`{ payload: unknown; timestamp: Date; instanceId: string; workflowName: string; schedule?: WorkflowCronSchedule }`.

## 3. Binding from a Worker: the handle surface

`yield* MyWorkflow` inside an Effect-native Worker's init returns a `WorkflowHandle<Input, Result>`
(`alchemy:Cloudflare/Workflows/Workflow.ts:427-501`):

```ts
export interface WorkflowHandle<Input = unknown, Result = unknown> {
  Type: "Cloudflare.Workflow";
  name: string;
  create(options?: WorkflowInstanceCreateOptions<Input>): Effect.Effect<WorkflowInstance<Result>>;
  createBatch(
    batch: WorkflowInstanceCreateOptions<Input>[],
  ): Effect.Effect<WorkflowInstance<Result>[]>;
  get(instanceId: string): Effect.Effect<WorkflowInstance<Result>>;
  deleteBatch(instanceIds: string[]): Effect.Effect<WorkflowBatchDeleteResult>;
}
export interface WorkflowInstanceCreateOptions<Input = unknown> {
  id?: string;
  params?: Input;
  retention?: { successRetention?: string | number; errorRetention?: string | number };
}
export interface WorkflowInstance<Result = unknown> {
  id: string;
  status(): Effect.Effect<WorkflowInstanceStatus<Result>>;
  pause(): Effect.Effect<void>;
  resume(): Effect.Effect<void>;
  restart(options?: {
    from?: { name: string; count?: number; type?: "do" | "sleep" | "waitForEvent" };
  }): Effect.Effect<void>;
  terminate(): Effect.Effect<void>;
  delete(): Effect.Effect<void>;
  subscribe(options?: WorkflowInstanceSubscribeOptions): Stream.Stream<WorkflowSubscriptionEvent>;
  sendEvent<Event = unknown>(event: { type: string; payload?: Event }): Effect.Effect<void>;
}
export interface WorkflowInstanceStatus<Result = unknown> {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown"
    | (string & {});
  output?: Result;
  error?: { name: string; message: string } | null;
  rollback?: {
    outcome: "complete" | "failed";
    error: { name: string; message: string } | null;
  } | null;
}
```

How the handle is implemented (`Workflow.ts:1035-1057`, `wrapInstance` at `:1386-1427`):

- **Every method is `Effect.tryPromise(...).pipe(Effect.orDie)`. Error channels are `never`, and
  every failure becomes a defect.** Examples are a duplicate `create` ID, `get` of an unknown ID,
  `sendEvent` to a terminal instance, and a `resume` on a running instance. A pool that must react to
  these failures has to catch defects, or call the raw binding.
- `get(id)` makes a network call. The native `get` resolves only after it locates the instance (the
  local shim even calls `status()`: `runtime:core/bindings/workflows/wrapped-binding.worker.ts:10-16`).
  So `get` followed by `sendEvent` costs **two** round trips per dispatch. Keeping the
  `WorkflowInstance` returned by `create` avoids the `get`, but only within the same isolate.
- **Gaps compared with the native binding** (§8): `createBatch` exposes only the deprecated array
  form, so the object form `{ count, params, retention, locationHint }` with a per-instance `errors`
  result is not exposed. `locationHint` is not exposed on `create` either. `terminate()` takes no
  `{ rollback }` option. `restart` is typed but passes `options` through.

## 4. Entrypoint class generation

When a Worker's export map contains Workflow exports, Rolldown generates a virtual entry
(`alchemy:Cloudflare/Workers/Sources/Rolldown.ts:259-312`):

```ts
import { env, DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import {
  makeDurableObjectBridge,
  makeWorkerBridge,
  makeWorkflowBridge,
} from "alchemy/Cloudflare/Bridge";
import entrypoint from "<your main>";
const meta = { entrypoint, stack: { name: "<stack>", stage: "<stage>" } };
export default makeWorkerBridge(WorkerEntrypoint, meta);
const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, meta);
export class ParkedWorkflow extends WorkflowBridgeFn("ParkedWorkflow") {}
```

You never write or export the `WorkflowEntrypoint` class in Effect-native mode. Classifying exports
as `kind: "workflow"` uses `isWorkflowExport` (`Workflow.ts:242-260`).

## 5. Mapping onto native `WorkflowEntrypoint` and `WorkflowStep`

`makeWorkflowBridge(WorkflowEntrypoint, meta)(className)` is in
`alchemy:Cloudflare/Workflows/WorkflowBridge.ts:36-124`.

- **Constructor** (`:59-73`): starts `build`, which resolves the Worker export against the
  **isolate-lifetime shared build**. One run of the Worker's init closure is shared by the default
  Worker, every DO and every Workflow class in the isolate (`alchemy:Cloudflare/Workers/WorkerBridge.ts:211-220`,
  `getWorkerExport` at `:341-365`). It then calls `wf.make(env)`.
- **`run(event, step)`** (`:75-122`):
  1. awaits the build;
  2. runs `fn(event.payload)` with `WorkflowEvent`, a wrapped `WorkflowStep`, a fresh `Scope`, and
     telemetry provided;
  3. closes the scope (unless ejected);
  4. returns the success value, or throws `Cause.squash(cause)`.
- Native `step.do` overloads are selected according to whether config and rollback are present
  (`WorkflowBridge.ts:193-198`).

Latency implication: the first `run` in a cold isolate pays the full Effect layer build of the
**whole** hosting Worker before any step executes. This happens because the build is keyed per
entrypoint module. Every replay of a parked instance (after hibernation, or after `sendEvent` wakes
it) re-enters `run`, which is cheap on a warm isolate and costs a full build on a cold one. The
benchmark must measure this cost and should not assume it.

## 6. Deploy-time resource (`WorkflowResource`, `alchemy:Cloudflare/Workflows/Workflow.ts:1081-1358`)

```ts
export interface WorkflowResourceProps {
  workflowName?: string;
  className: string;
  scriptName?: string;
  limits?: WorkflowLimits; // { steps?: number } only (:265-270)
  schedules?: string[]; // cron expressions; [] clears them
}
export interface WorkflowResourceAttrs {
  workflowId: string;
  workflowName: string;
  className: string;
  scriptName: string;
  accountId: string;
  schedules: string[];
}
```

User-facing `WorkflowProps` (`:323-347`) are `{ workflowName?, limits?, schedules? }`. The class
name and script are derived.

**Physical name.** When `workflowName` is omitted, the name is `${scriptName}-${className}`,
lowercased, with non-`[a-z0-9-]` characters replaced. It is truncated so that, with the suffix
`-<sha256[0:8]>`, it fits in 64 characters (`alchemy:Cloudflare/Workflows/WorkflowName.ts:26-34`). An
explicit `workflowName` must be unique per stack and stage. Adopting an existing name requires
`--adopt`, and changing the name forces a replacement (`:1163-1194`, `:1228-1253`).

**Live reconcile.** Reconcile calls `workflows.putWorkflow({ accountId, workflowName, className, scriptName, limits, schedules })`
from `@distilled.cloud/cloudflare`. The call is an upsert, and omitted schedules preserve the
observed ones (`:1219-1277`). Delete calls `deleteWorkflow` and ignores `WorkflowNotFound`
(`:1278-1286`).

**No retention prop.** There is no Workflow-level retention or `default_retention` prop. Retention
is per instance only, through `create({ retention })` (`:443-453`). The worker binding carries only
`name`, `workflowName` and `className` (`:1009-1018`).

**Providers.** `WorkflowProvider()` selects between `ProviderLocal` and `ProviderLive`
(`:1354-1358`). The local provider is virtual: it creates a `dev:` id and no API calls
(`:1296-1352`).

## 7. Local dev (`alchemy dev`)

- `LocalWorkerProvider` collects `workflow` bindings owned by the Worker into
  `workflows[workflowName] = { workflowName, className }`
  (`alchemy:Cloudflare/Workers/LocalWorkerProvider.ts:380-393`, passed on at `:474`).
  **It does not pass `stepLimit`.** `runtime:core/RuntimeWorker.ts:159-173` supports `stepLimit`, but
  `limits.steps` is not enforced locally.
- Each binding is lowered with `Workflows.local({ binding, workflowName, className, scriptName })`
  (`alchemy:Cloudflare/Workers/RuntimeBindings.ts:252-258`).
- `runtime:core/bindings/workflows/Workflows.ts` sets up the local engine:
  - For each owned workflow it adds a workerd service `workflows:<workflowName>` (`:122-179`). The
    service hosts an `Engine` Durable Object with `enableSql: true` and **`preventEviction: true`**,
    and binds `USER_WORKFLOW` to the user worker's entrypoint `className`.
  - Persistence goes to `<storage>/workflows` (`:41-67`).
  - Same-script bindings wrap the engine's `WorkflowBinding` entrypoint (`:244-258`). Cross-script
    bindings go through the dev-registry proxy (`:260-275`).
- The engine is a vendored copy of `@cloudflare/workflows-shared` at workers-sdk commit `f9e7727`
  (`runtime:internal/workflows-shared/README.md`). The shim that turns it into the `Workflow`
  binding is `runtime:core/bindings/workflows/wrapped-binding.worker.ts:7-141`.
- Local `create()` returns as soon as it has queued the work. `Engine.init` is fire-and-forget under
  `ctx.waitUntil` (`runtime:internal/workflows-shared/binding.ts:190-249`).
- The local default `waitForEvent` timeout is `"24 hours"`
  (`runtime:internal/workflows-shared/context.ts:1162-1176`).
- Local `receiveEvent` queues events that arrive before a waiter exists. If the engine is asleep in
  `Waiting`, it stores the event and starts the engine (`engine.ts:1162-1200`).

Consequence for this project: local timings come from a never-evicted engine DO inside one workerd
process. They say nothing about production scheduling or pre-start benefit, which matches the
AGENTS.md benchmark rule.

## 8. Native types (`@cloudflare/workers-types` 5.20261007.1)

The following live inside `declare namespace CloudflareWorkersModule` (`wt:16427`), which is
exported as `"cloudflare:workers"` (`wt:16683-16685`).

`WorkflowStepConfig` (`wt:16496-16503`):

```ts
export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDelayDuration | number | WorkflowDelayFunction;
    backoff?: WorkflowBackoff;
  };
  timeout?: WorkflowTimeoutDuration | number;
  sensitive?: WorkflowStepSensitivity;
};
```

`WorkflowSleepDuration` (`wt:16480-16494`) is `` `${number} ${"second"|"minute"|"hour"|"day"|"week"|"month"|"year"}${"s"|""}` | number ``.

`WorkflowEvent` and `WorkflowStepEvent` (`wt:16541-16553`):

```ts
export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
  workflowName: string;
  schedule?: WorkflowCronSchedule;
};
export type WorkflowStepEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  type: string;
  sensitive?: WorkflowStepSensitivity;
};
```

`WorkflowStep` (`wt:16599-16644`; the overloads are abridged):

```ts
export abstract class WorkflowStep {
  do<T extends Rpc.Serializable<T>>(name: string, callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>): Promise<T>;
  do<T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfigWithDelayFunction, callback: …, rollbackOptions?: …): Promise<T>;
  do<T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfigWithStaticDelay, callback: …, rollbackOptions?: …): Promise<T>;
  do<T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfig, callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>): Promise<T>;
  sleep: (name: string, duration: WorkflowSleepDuration) => Promise<void>;
  sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
  waitForEvent<T extends Rpc.Serializable<T>>(
    name: string,
    options: { type: string; timeout?: WorkflowTimeoutDuration | number },
  ): Promise<WorkflowStepEvent<T>>;
}
```

`WorkflowInstanceStatus` and `WorkflowEntrypoint` (`wt:16645-16669`):

```ts
export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";
export abstract class WorkflowEntrypoint<
  Env = unknown,
  T extends Rpc.Serializable<T> | unknown = unknown,
>
  implements Rpc.WorkflowEntrypointBranded
{
  [Rpc.__WORKFLOW_ENTRYPOINT_BRAND]: never;
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env);
  run(event: Readonly<WorkflowEvent<T>>, step: WorkflowStep): Promise<unknown>;
}
```

`NonRetryableError` (`wt:18194-18202`):

```ts
declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    public constructor(message: string, name?: string);
  }
}
```

The `Workflow` binding is global (`wt:18203-18243`):

```ts
declare abstract class Workflow<PARAMS = unknown> {
  public get(id: string): Promise<WorkflowInstance>;
  public create(options?: WorkflowInstanceCreateOptions<PARAMS>): Promise<WorkflowInstance>;
  public createBatch(
    options: WorkflowBatchCreateOptions<PARAMS>,
  ): Promise<WorkflowBatchCreateResult>;
  /** @deprecated Use the object form of `createBatch` instead of the array form. */
  public createBatch(batch: WorkflowInstanceCreateOptions<PARAMS>[]): Promise<WorkflowInstance[]>;
  public deleteBatch(instanceIds: string[]): Promise<WorkflowBatchDeleteResult>;
}
```

Its doc comments say `createBatch` is "limited at 100 instances at a time or when the RPC limit for
the batch (1MiB) is reached". In the deprecated array form, instances that already exist "are
omitted from the result without an error".

`WorkflowBatchCreateOptions` and `WorkflowBatchCreateResult` (`wt:18244-18270`):

```ts
type WorkflowBatchCreateOptions<PARAMS = unknown> =
  | { count: number; params?: PARAMS; retention?: {…}; locationHint?: WorkflowInstanceLocationHint; instances?: never }
  | { instances: WorkflowInstanceCreateOptions<PARAMS>[]; count?: never; params?: never; retention?: never; locationHint?: never };
type WorkflowBatchCreateResult = {
  created: WorkflowInstance[];
  errors: { index: number; id?: string; code: number; message: string }[];
};
```

`WorkflowInstanceCreateOptions` (`wt:18300-18320`):

```ts
interface WorkflowInstanceCreateOptions<PARAMS = unknown> {
  id?: string;
  params?: PARAMS;
  retention?: {
    successRetention?: WorkflowRetentionDuration;
    errorRetention?: WorkflowRetentionDuration;
  };
  locationHint?: WorkflowInstanceLocationHint; // "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "apac-ne" | "apac-se" | "oc" | "afr" | "me"
}
```

`InstanceStatus` (`wt:18321-18338`):

```ts
type InstanceStatus = {
  status:
    | "queued" // means that instance is waiting to be started (see concurrency limits)
    | "running"
    | "paused"
    | "errored"
    | "terminated" // user terminated the instance while it was running
    | "complete"
    | "waiting" // instance is hibernating and waiting for sleep or event to finish
    | "waitingForPause" // instance is finishing the current work to pause
    | "rollingBack"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};
```

`WorkflowInstanceTerminateOptions` and `WorkflowInstanceRestartOptions` (`wt:18343-18370`) are
`{ rollback?: boolean }` and `{ from?: { name: string; count?: number; type?: "do" | "sleep" | "waitForEvent" } }`.

`WorkflowInstance` (`wt:18541-…`):

```ts
declare abstract class WorkflowInstance {
  public id: string;
  public pause(): Promise<void>;
  public resume(): Promise<void>;
  public terminate(options?: WorkflowInstanceTerminateOptions): Promise<void>;
  public restart(options?: WorkflowInstanceRestartOptions): Promise<void>;
  public delete(): Promise<void>;
  public status(): Promise<InstanceStatus>;
  public sendEvent({ type, payload }: { type: string; payload: unknown }): Promise<void>;
  public subscribe(
    options?: WorkflowInstanceSubscribeOptions,
  ): Promise<WorkflowInstanceSubscription>;
}
```

Relevance to the pool: the native `createBatch({ count, params })` form, with per-index `errors`,
fits low-water-mark batch refill. Alchemy's handle does not expose it, so refill through Alchemy
means the deprecated array form (silent omission of duplicates), or reaching past the handle to the
raw `env` binding.

## 9. Tests and examples in the packages

- `alchemy` ships no tests. Its executable examples are the JSDoc blocks in
  `alchemy:Cloudflare/Workflows/Workflow.ts:564-958`: minimal, named, step limit, cron, task with
  retries and context, rollback, sleep, `waitForEvent`, KV inside task, create/createBatch/get/status,
  sendEvent plus restart, HTTP routes, async-Worker binding, Queue subscription to Workflow events,
  `Workflow.ref`, cross-script, polling test, subscribe/delete.
- `@alchemy.run/cloudflare-runtime` ships tests:
  - `runtime:core/test/bindings/Workflows.test.ts` covers persistence across runs, subscribe through
    the wrapper, and cross-process access.
  - The vendored upstream engine tests are under `runtime:internal/workflows-shared/test/`
    (`binding.test.ts`, `engine.test.ts`, `context.test.ts`, `validators.test.ts`).

## 10. Minimal example: park on `waitForEvent`, then dispatch

The three files below type-check with `tsc` 7.0.2 under the benchmarks `tsconfig` settings (strict,
`exactOptionalPropertyTypes`, `@cloudflare/workers-types`). They were checked in a scratch
directory that symlinked `apps/benchmarks/node_modules`. A deliberate wrong `params` type was
rejected, which confirms that `Input` is inferred from the run body. They have **not** been
deployed.

`src/parked-workflow.ts`:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";

/** Event type a parked instance waits for before doing any work. */
export const DISPATCH_EVENT_TYPE = "dispatch";

/** Payload a dispatcher sends to a parked instance. */
export const DispatchPayload = Schema.Struct({
  requestId: Schema.String,
  sentAt: Schema.Finite,
});

/** Workflow whose first step parks on `waitForEvent` until a dispatcher claims it. */
export class ParkedWorkflow extends Cloudflare.Workflow<ParkedWorkflow>()(
  "ParkedWorkflow",
  Effect.gen(function* () {
    // Init phase: runs once per isolate build, not per instance.
    return Effect.fn(function* (_input: { readonly poolId: string }) {
      const event = yield* Cloudflare.Workflows.waitForEvent<unknown>("await-dispatch", {
        type: DISPATCH_EVENT_TYPE,
        timeout: "1 hour",
      });
      // waitForEvent's type parameter is an unchecked cast; decode the payload.
      const payload = yield* Schema.decodeUnknownEffect(DispatchPayload)(event.payload);

      return yield* Cloudflare.Workflows.task(
        "handle-dispatch",
        Effect.sync(() => ({
          requestId: payload.requestId,
          eventTimestamp: event.timestamp.getTime(),
          handledAt: Date.now(),
        })),
      );
    });
  }),
) {}
```

`src/pool-worker.ts`:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { DISPATCH_EVENT_TYPE, ParkedWorkflow } from "./parked-workflow.ts";

/** Worker that pre-starts parked Workflow instances and dispatches to them. */
export class PoolWorker extends Cloudflare.Worker<PoolWorker, {}>()("PoolWorker") {}

/** Provides the pool Worker's runtime implementation. */
const poolWorkerLayer = PoolWorker.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    // Yielding the class registers the Workflow resource, adds the `workflow`
    // binding to this Worker, and exports the entrypoint class from its bundle.
    const parked = yield* ParkedWorkflow;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (request.method === "POST" && url.pathname === "/park") {
          const instance = yield* parked.create({ params: { poolId: "default" } });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }

        const instanceId = url.pathname.match(/^\/dispatch\/([^/]+)$/)?.[1];
        if (request.method === "POST" && instanceId !== undefined) {
          const instance = yield* parked.get(instanceId);
          yield* instance.sendEvent({
            type: DISPATCH_EVENT_TYPE,
            payload: { requestId: crypto.randomUUID(), sentAt: Date.now() },
          });
          return yield* HttpServerResponse.json({ instanceId });
        }

        const statusId = url.pathname.match(/^\/status\/([^/]+)$/)?.[1];
        if (statusId !== undefined) {
          const instance = yield* parked.get(statusId);
          return yield* HttpServerResponse.json(yield* instance.status());
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
);

export default poolWorkerLayer;
```

`alchemy.run.ts`:

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import poolWorkerLayer, { PoolWorker } from "./src/pool-worker.ts";

/** Provision the pool Worker and its hosted Workflow. */
const PoolStack = Alchemy.Stack(
  "WorkflowPoolExample",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* PoolWorker;
    return { url: worker.url };
  }).pipe(Effect.provide(poolWorkerLayer)),
);

export default PoolStack;
```

Notes on the example:

- `PoolWorker.make`'s `InitReq` excludes `WorkerServices`, which includes `Worker`. That is why
  `yield* ParkedWorkflow` type-checks inside `make` with no extra provision
  (`alchemy:Cloudflare/Workers/Worker.ts:86-93`, `:2402-2413`).
- Per §3, `create`, `get` and `sendEvent` die on failure. A production dispatcher should catch
  defects around `sendEvent` and fall back to a cold `create`.
- Native `sendEvent` resolving does not mean the first post-event step has run. Measure that
  separately, for example by timestamping inside `handle-dispatch` (as `handledAt` does here)
  against the dispatcher's send time.
