# Observability: Axiom traces per Alchemy stage

Every deployed stage sends OpenTelemetry traces to Axiom. Production writes to its own dataset.
Every other stage (pull-request previews, branches, agent or developer deploys, and local development when opted in) writes to a single shared preview dataset.
Alchemy adds `alchemy.stack` and `alchemy.stage` resource attributes to every span (`alchemy/src/TelemetryRuntime.ts`), so one stage's traces are selected by filtering on `alchemy.stage`.

## Resources

| Resource                 | Axiom name                                 | Retention | Lifecycle                                              |
| ------------------------ | ------------------------------------------ | --------- | ------------------------------------------------------ |
| Production trace dataset | `cf-workflow-pool-production-traces`       | 30 days   | Permanent, retained on destroy                         |
| Preview trace dataset    | `cf-workflow-pool-preview-traces`          | 7 days    | Permanent, retained on destroy                         |
| Production ingest token  | `cf-workflow-pool-production-trace-ingest` | —         | Permanent; can only ingest into the production dataset |
| Preview ingest token     | `cf-workflow-pool-preview-trace-ingest`    | —         | Permanent; can only ingest into the preview dataset    |

Definitions live in `packages/shared-infrastructure/src/axiom/cf-workflow-pool-trace-resources.ts`.

## Ownership and stage isolation

This is the documented exception to per-stage isolation that `docs/coding-standards.md` allows for shared observability datasets.

- **Owner:** the `CfWorkflowPoolObservability` Stack (`packages/shared-infrastructure`). It deploys only to stage `production` and refuses any other stage.
- **Consumers:** application Stacks reference its outputs with `CfWorkflowPoolObservabilityStack.stage.production`. No application stage creates Axiom resources, so preview and agent deploys need Cloudflare credentials only, never Axiom credentials.
- **Destination choice:** `apps/benchmarks/src/benchmarks-trace-telemetry.ts` chooses the destination while deploying. Stage `production` uses the production dataset and token; every other stage uses the preview dataset and token. The endpoint, dataset header, and bearer token are bound onto the Worker. The token is bound as a secret.
- **Provider selection:** the Axiom resources have no local provider and are always live. `alchemy dev` does not export traces unless `BENCHMARKS_TRACE_LOCAL=true` is set while starting it, in which case local spans go to the preview dataset.

## Ordering

1. `vp run deploy:observability` creates or updates the datasets and tokens. This needs Axiom credentials.
2. Application deploys come next. `@cf-workflow-pool/benchmarks#deploy:production` and `#plan:production` depend on the observability tasks. A preview deploy (`alchemy deploy --stage pr-42`) needs the observability Stack to have been deployed once already.
3. Destroying an application stage never touches the observability Stack. Destroying the observability Stack deletes the tokens but keeps both datasets.

## Switches

| Variable                           | Read when                      | Effect                                                                                                                        |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `BENCHMARKS_TRACING_ENABLED=false` | Deploying the benchmarks Stack | No exporter is bound, so the deployed Worker exports no traces. Use it to compare benchmark latency with and without tracing. |
| `BENCHMARKS_TRACE_LOCAL=true`      | Running `alchemy dev`          | Exports local traces to the preview dataset.                                                                                  |

## Querying

Use `pnpm traces` (`apps/traces`). The `traces` skill (`.agents/skills/traces/SKILL.md`) describes the debugging loop. The CLI resolves a stage to its dataset and filters on the stage with `tostring(['resource.custom']['alchemy.stage'])`. That field path follows Axiom's documented OpenTelemetry mapping, but it is still unconfirmed against ingested spans; `TRACE_STAGE_FIELD_APL` in `apps/traces/src/trace-apl.ts` is the one place to change it.

Local development exports traces only through `pnpm dev:benchmarks:traced`, which sets `BENCHMARKS_TRACE_LOCAL=true` and runs stage `local`.

## Tracing

Every benchmark run produces connected spans across the bench CLI, the BenchmarksDriver Worker, the InventoryServer Durable Object, and each CheckoutWorkflow run. The CLI exports under `service.name` `cf-workflow-pool-bench-cli`; everything deployed exports under `cf-workflow-pool-benchmarks-driver`. The attribute `cf_workflow_pool.runtime.component` says which component created a span: `bench-cli`, `benchmarks-driver-worker`, `inventory-durable-object`, or `checkout-workflow`.

### Span tree

One trace per run (trace ID chosen by the CLI):

```text
bench.run                                         bench-cli
└─ bench.batch                       (per batch attempt)
   └─ http.client POST /v1/benchmarks/checkout    ── traceparent ──▶
      http.server POST /v1/benchmarks/checkout    benchmarks-driver-worker
      └─ CheckoutBenchmark.runCheckoutBatch
         └─ checkout.sample          (per sample; measured values set when it ends)
            ├─ InventoryClient.setStock → http.client PUT /v1/stock ──▶ http.server PUT /v1/stock (inventory-durable-object)
            ├─ checkout.await_reservation  reservation.status=reserved
            │  └─ … http.client GET /v1/reservations/:orderId/await ──▶ http.server … ─ InventoryLedger.awaitReservationStatus
            ├─ checkout.start              (create())
            │  └─ CheckoutWorkflows.startCheckout   ← its traceparent goes into CheckoutParams
            ├─ checkout.await_reservation  reservation.status=confirmed
            └─ checkout.send_payment_authorization
               └─ CheckoutWorkflows.sendPaymentAuthorization ← its traceparent goes into the event payload
```

One trace per Workflow run invocation, linked to the run's trace:

```text
checkout.workflow.run       checkout-workflow; links: checkout.start, payment.authorized
├─ workflow.step reserve-inventory      (per attempt)
│  └─ InventoryClient.reserve → http.client POST /v1/reservations ──▶ http.server POST /v1/reservations
│                                                                     └─ InventoryLedger.reserve
├─ workflow.wait await-payment          (once; reserve completed → body continued past the wait)
├─ workflow.step capture-payment
└─ workflow.step confirm-reservation
   └─ … http.server POST /v1/reservations/:orderId/confirm
```

- **CLI → driver and driver → InventoryServer** are parent/child spans in one trace. Effect's `HttpClient` injects a W3C `traceparent` (plus `b3`) into every request, exporting or not. The server tracer in Effect's HTTP handler reads it. Alchemy's `toHttpClient` hands the client request's headers to the Durable Object stub unchanged.
- **Driver → Workflow** is a _link_, not a parent. Alchemy's Workflow bridge creates no spans and propagates no context, so the driver puts a trace context (`traceparent` plus baggage) into `CheckoutParams` and the payment event payload. The baggage carries `benchmark.run_id`, `benchmark.batch_id`, and `benchmark.label`; the run span and every span under it copy those from `CheckoutParams`, so `traces find benchmark.run_id=<id>` finds the Workflow traces too. `traces find … --follow-links` lists the traces that link to the matches. The run span links to both: `link.kind` is `checkout.start` or `payment.authorized`. A link is used because the engine re-invokes the run body from the top after hibernation (for example while it waits for the payment). As a child, every re-invocation would add another run span under a driver span that ended long ago. Each invocation therefore gets its own `checkout.workflow.run`. Steps already completed are replayed from storage, run no attempt, and produce no `workflow.step` span; only the attempts that actually execute appear. `workflow.run.replayed` on the run span says whether that invocation replayed `reserve-inventory` from the journal.
- **The payment wait** is a `workflow.wait await-payment` span. A span around `waitForEvent` would report about 0 ms on a replay, and the waiting invocation may be evicted before exporting. So the span starts at the `completedAt` journaled with `reserve-inventory`'s output, ends when the run body continued past the wait (both on the Workflow isolate's clock), and is recorded inside `capture-payment`'s first attempt, which runs exactly once. The event's own `timestamp` is kept only as `workflow.wait.event_timestamp`: in production it reads 50–150 ms _after_ the body had already resumed, so it is on another clock and is not a receipt time. Splitting the wait into event delivery and body wake-up therefore isn't possible from inside the Workflow; the driver's `resumeMs` remains the end-to-end measure.
- HTTP span names are normalized: identifiers become route parameters, and the query is dropped (`http.server POST /v1/reservations/:orderId/confirm`).
- The driver and inventory HTTP APIs assign a request ID (`req_<uuid>`) per request. It is set as `request.id` on the `http.server` span, on every nested span, and on logs, together with `cf.ray` when Cloudflare sends one. The ID is returned in the `x-request-id` header on success and error responses. The CLI records the driver's request ID for every batch attempt in `meta.json` (`batches[].requestId`), next to any transport failure.

### Attribute names

| Attribute                                                                                                               | Set on                                                      | Meaning                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf_workflow_pool.runtime.component`                                                                                    | every span                                                  | Component that created the span                                                                                                                                              |
| `benchmark.run_id`                                                                                                      | CLI spans, driver batch/sample spans                        | Run, generated by the CLI                                                                                                                                                    |
| `benchmark.batch_id`                                                                                                    | `bench.batch`, driver batch/sample spans                    | One batch attempt; also on each `CheckoutSample`                                                                                                                             |
| `benchmark.label`                                                                                                       | CLI spans, driver batch/sample spans                        | `--label`                                                                                                                                                                    |
| `benchmark.batch_index`, `benchmark.batch_attempt`                                                                      | `bench.batch`                                               | Batch position and attempt                                                                                                                                                   |
| `benchmark.concurrency`, `benchmark.burst_index`                                                                        | driver batch/sample spans                                   | Batch concurrency, sample position in batch                                                                                                                                  |
| `benchmark.create_ms`, `benchmark.first_step_ms`, `benchmark.send_event_ms`, `benchmark.resume_ms`, `benchmark.outcome` | `checkout.sample`                                           | The sample's measurements (absent when not reached)                                                                                                                          |
| `benchmark.reserve_ms`, `benchmark.wakeup_ms`, `benchmark.outcome`                                                      | `inventory_wakeup.sample`                                   | Baseline measurements                                                                                                                                                        |
| `benchmark.reservation_observed_via`, `benchmark.confirmation_observed_via`, `benchmark.wakeup_observed_via`            | `checkout.sample`, `inventory_wakeup.sample`                | `woken`, or `already-reached`: the long-poll arrived after the status changed, so the measurement is overstated and the summary leaves it out                                |
| `checkout.order_id`, `checkout.sku`                                                                                     | sample spans, InventoryServer `http.server`, Workflow spans | Order (= Workflow instance ID) and SKU (= InventoryServer name)                                                                                                              |
| `workflow.instance_id`                                                                                                  | Workflow spans                                              | CheckoutWorkflow instance                                                                                                                                                    |
| `workflow.step.name`, `workflow.step.attempt`                                                                           | `workflow.step <name>`                                      | Step and its one-based attempt                                                                                                                                               |
| `workflow.wait.name`, `workflow.wait.ms`, `workflow.wait.event_timestamp`                                               | `workflow.wait <name>`                                      | Wait from the previous step completing until the body continued past the wait, on the Workflow isolate's clock; the event's own timestamp for reference only (another clock) |
| `workflow.run.replayed`                                                                                                 | `checkout.workflow.run`                                     | The invocation replayed `reserve-inventory` from the journal, i.e. the engine re-invoked the run body                                                                        |
| `benchmark.run_id`, `benchmark.batch_id`, `benchmark.label` (from baggage)                                              | `checkout.workflow.run` and its children                    | Copied from the trace context baggage in `CheckoutParams`                                                                                                                    |
| `reservation.status`                                                                                                    | `checkout.await_reservation`, ledger spans                  | Awaited status, or status after the operation                                                                                                                                |
| `inventory.waiter_count`, `inventory.woken_waiter_count`, `inventory.await_result`                                      | ledger spans                                                | Long-poll waiters remaining, woken, and whether a wait was needed                                                                                                            |
| `request.id`, `cf.ray`                                                                                                  | server spans and their children, `bench.batch`              | Request correlation                                                                                                                                                          |
| `link.kind`                                                                                                             | links on `checkout.workflow.run`                            | `checkout.start` or `payment.authorized`                                                                                                                                     |
| `alchemy.stage`                                                                                                         | resource (all); CLI from `--stage`                          | Stage                                                                                                                                                                        |

The names live in `apps/benchmarks/src/benchmark-trace-attributes.ts`; use that module rather than string literals.

### Finding a run, a batch, or a slow sample

The custom-attribute field path below (`['attributes.custom']['…']`) is an assumption, as is the resource path in [Querying](#querying). Confirm both against the first ingested spans and fix the queries here.

```apl
// One run: every driver and CLI span (the CLI prints the run ID; it is also in meta.json)
['cf-workflow-pool-production-traces']
| where ['attributes.custom']['benchmark.run_id'] == "<run-id>"

// One batch, by its request ID from meta.json
['cf-workflow-pool-production-traces']
| where ['attributes.custom']['request.id'] == "req_<uuid>"
| project trace_id, span_id, name, duration

// The slowest samples of a run by first-step latency
['cf-workflow-pool-production-traces']
| where name == "checkout.sample" and ['attributes.custom']['benchmark.run_id'] == "<run-id>"
| extend first_step_ms = todouble(['attributes.custom']['benchmark.first_step_ms'])
| top 20 by first_step_ms desc
| project trace_id, first_step_ms, ['attributes.custom']['checkout.order_id'], ['attributes.custom']['benchmark.outcome']

// Explain one slow sample: the Workflow side lives in its own trace, found by order ID
['cf-workflow-pool-production-traces']
| where ['attributes.custom']['checkout.order_id'] == "<order-id>"
| sort by _time asc
| project _time, trace_id, name, duration, ['attributes.custom']['cf_workflow_pool.runtime.component'], ['attributes.custom']['workflow.step.attempt']
```

For a slow `first_step_ms`, compare in that last query:

- the `checkout.start` duration (`create_ms`);
- the gap until `workflow.step reserve-inventory` starts (scheduling and isolate build);
- the `InventoryLedger.reserve` span;
- when `checkout.await_reservation` (`reserved`) ends.

### Timing

Tracing adds no I/O between `t0` and `t5`. Spans are created in memory, and the per-event exporter flushes from the event's scope finalizer in `waitUntil` after the response. The remaining risks, each to be checked with a deployed A/B run using `BENCHMARKS_TRACING_ENABLED=false`:

- **Mid-request export.** Effect's OTLP exporter exports early once 1000 spans are buffered. A checkout sample creates about 15–20 driver-side spans, so batches of 50 can come close. Keep `--batch-size` at 20 (the default) or below until the per-sample count is measured.
- **Workflow flush.** The Workflow bridge has no `waitUntil` and closes the run scope inline, so a run invocation flushes its spans before it returns. If an invocation unwinds while parked on the payment event, that flush could delay resumption and inflate `resume_ms` (never `first_step_ms`).
- **CPU.** Request-ID middleware and span bookkeeping add small CPU work and one response header on every InventoryServer request inside the measured path.

### Still unverified (needs a deployed run)

- That the Worker and Durable Object bridges pass the request's `traceparent` through to the server tracer in production, so driver → InventoryServer spans are actually parented.
- That span-name generators provided on the Worker and Durable Object layers reach the bridges' request handling (the same pattern works in Overseer).
- That Axiom shows span links, and the actual field paths for custom and resource attributes.
- How run re-invocations look for long parks. In the 2026-10-07 runs every instance produced exactly one `checkout.workflow.run` (no replays) for a sub-second payment wait.
- Whether `cf-ray` is present on driver requests (it should be) and on Durable Object requests (it probably is not).
- That the CLI's OTLP export reaches Axiom with `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.axiom.co/v1/traces` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer%20<token>,X-Axiom-Dataset=<dataset>`.
