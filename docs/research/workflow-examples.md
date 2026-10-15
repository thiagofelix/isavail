# Example workflows for the benchmark and demo

Gathered 2026-10-07. The question: which well-known durable-workflow example should we implement
for the cold-start benchmark and the `cf-workflow-pool` demo? We want something recognisable,
something that runs realistic Cloudflare Workflows steps, and something whose first step a user
actually waits on, so that start latency matters.

## How each candidate is assessed

- **Steps and compensation**: the forward steps, and the undo actions that run when a later step fails.
- **Latency-sensitive first step**: whether a person is waiting on the result of the first step.
  For example, a checkout button that blocks until stock is reserved. If nobody waits, a 1 s start
  cost does not matter and the pool has nothing to show.
- **Dependencies and fakes**: what the example calls, and how easily that can be faked on Workers
  with a Durable Object (DO), D1, or an in-memory stub.
- **Workflows feature coverage**: whether it exercises `step.do` retries, `NonRetryableError`,
  rollback, `step.sleep`, and `step.waitForEvent`.

### Cloudflare Workflows has native saga support

`step.do(name, fn, { rollback, rollbackConfig })` registers a compensation handler. When the
instance later fails, Workflows runs the registered handlers in reverse step-start order. This
includes the handler of a step that failed with `NonRetryableError`; that handler receives
`output: undefined`. Rollback handlers get `{ error, output }` and have their own retry
configuration. ([Sleeping and retrying → Register rollback handlers](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/))

Alchemy v2 exposes the same feature as `Cloudflare.Workflows.task(name, effect, { rollback, rollbackConfig })`
(see [`alchemy-v2-workflows.md`](alchemy-v2-workflows.md)). As a result, any saga-shaped example
maps directly onto the platform, with no compensation stack written by hand as in the Temporal and
Restate samples.

Other primitives relevant here:

- **`step.do` retries**: the default is 5 retries, a 10 s delay, exponential backoff, and a
  10 min timeout. The delay can also be a function of the attempt number and the error.
- **`NonRetryableError`**: fails the instance immediately.
- **`step.sleep` / `step.sleepUntil`**: durable timers.
- **`step.waitForEvent({ type, timeout })`**: waits for an event delivered by `instance.sendEvent()`.

## Candidates

### 1. Money transfer (Temporal's "hello world")

Sources: [Temporal money-transfer template (Go)](https://github.com/temporalio/money-transfer-project-template-go/blob/main/workflow.go),
[Temporal samples-go `saga`](https://github.com/temporalio/samples-go/blob/main/saga/workflow.go).

- **Steps**: `Withdraw(source)` → `Deposit(target)`. The samples-go version adds a final
  `StepWithError` to force compensation.
- **Compensation**: if the deposit fails, `Refund` the source. samples-go uses deferred
  `WithdrawCompensation` and `DepositCompensation` calls that run in reverse order.
- **Retries**: an exponential retry policy, with `InsufficientFundsError` and
  `InvalidAccountError` marked non-retryable. This maps directly onto `NonRetryableError`.
- **Latency-sensitive first step**: **yes**. The user presses "Send" and waits for the
  withdraw/hold result.
- **Fakes**: very easy. Use one `Account` DO per account (a strongly consistent balance, which is
  an idempotent debit/credit keyed by transfer id), or two rows in D1. Failure injection can be a
  payload flag or a non-existent target account.
- **Feature coverage**: retries, `NonRetryableError`, and rollback are covered. There is no
  `sleep` or `waitForEvent` unless we add something, such as a "hold for fraud review" step.
- **Verdict**: the smallest canonical saga, and the best match for a micro-benchmark because the
  steps do almost no work, so start latency dominates. As a demo it is thin.

### 2. Trip booking saga (the literature's canonical saga)

Sources: Garcia-Molina & Salem, ["Sagas", SIGMOD 1987](https://dl.acm.org/doi/10.1145/38713.38742)
([PDF](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf)); Caitie McCaffrey's
talk, via [cdk-patterns "The Saga Step Function"](https://github.com/cdk-patterns/serverless/blob/main/the-saga-stepfunction/README.md);
[aws-samples Step Functions saga (SAM)](https://github.com/aws-samples/aws-step-functions-saga-pattern-with-sam);
[Restate `booking_workflow.ts`](https://github.com/restatedev/examples/blob/main/typescript/patterns-use-cases/src/sagas/booking_workflow.ts);
[Bernd Rücker trip-booking-saga-serverless](https://github.com/berndruecker/trip-booking-saga-serverless).

- **Steps (simple form, as in Restate and aws-samples)**: book flight → book car → book hotel.
- **Steps (try-confirm-cancel form, cdk-patterns)**: reserve hotel (status pending) → reserve
  flight (pending) → take payment → confirm hotel → confirm flight → notify. This is the closest
  thing in these samples to **two-phase commit**: the reservations are the "prepare" phase and the
  confirmations are the "commit" phase.
- **Compensation**: cancel in reverse order, peeling back only the steps that completed. Restate
  registers each compensation _before_ the forward call, so a call that reached the remote side
  but failed locally is still undone. Workflows' rollback-on-failed-step (with
  `output: undefined`) gives the same behaviour. Terminal errors trigger compensation; transient
  errors are retried.
- **Latency-sensitive first step**: **moderate**. The user waits on "booking confirmed", but that
  outcome depends on all of the steps, so a fixed ~1 s start cost is a smaller fraction of the total.
- **Fakes**: easy. Use one DO class per provider (`Flights`, `Hotels`, `Cars`, `Payments`), each
  with seat or room capacity and idempotent reserve/confirm/cancel keyed by trip id. Each
  provider can be configured with a delay and a failure rate. For failure injection, the
  cdk-patterns sample uses `run_type` and Restate's account sample uses `shouldThrow`.
- **Feature coverage**: rollback gets the strongest exercise (3–4 compensations), along with
  retries and `NonRetryableError`. `step.sleep` fits naturally as a reservation hold that expires
  if payment does not arrive. `waitForEvent` fits a "payment captured" webhook.
- **Verdict**: the best-known saga and the best demo of compensation. Its first step is less
  start-latency-sensitive than checkout's.

### 3. E-commerce checkout / order saga

Sources: [DBOS widget store `checkout_workflow`](https://docs.dbos.dev/python/examples/widget-store);
[AWS Prescriptive Guidance: saga orchestration](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html)
(order → inventory → payment, with C1 and C2 on payment failure);
[Azure Architecture Center: Saga pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
(compensable, pivot, and retryable transactions); Cloudflare's own `OrderWorkflow` rollback
snippet (reserve inventory → charge card) in
[Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/);
[Cloudflare "Pay cart and send invoice"](https://developers.cloudflare.com/workflows/examples/send-invoices/).

- **Steps (DBOS)**: create order → reserve inventory → publish a payment id to the caller → **wait
  for the payment-status message** → mark the order paid and start fulfilment, _or_ undo the
  inventory reservation and cancel the order → publish the order id.
- **Compensation**: release inventory and cancel the order when payment fails or times out.
  AWS and Azure use the same shape. Azure's terminology fits it well: payment capture is the
  **pivot transaction**; everything after it, such as the confirmation email and fulfilment, is
  retryable rather than compensable.
- **Latency-sensitive first step**: **strongly yes, and it is on the critical path by design**.
  The checkout HTTP handler blocks until the workflow has reserved stock and emitted a payment
  id (DBOS `set_event`/`get_event`). That is exactly the create → first-step latency the thesis is
  about, and a pool removes it.
- **Fakes**: easy, and contention on a single SKU makes it realistic. The parts are an
  `Inventory` DO per SKU (atomic reserve/release, keyed by order id for idempotency), orders in
  D1 or the same DO, and a stub payment provider. The stub "webhook" calls
  `instance.sendEvent({ type: "payment", payload })`, possibly after a configurable delay.
- **Feature coverage**: **all of it**.
  - `step.do` with retries, plus `NonRetryableError` for out-of-stock or a declined card.
  - Rollback on the inventory step.
  - `step.waitForEvent("payment", { timeout })`, where a timeout means abandoned checkout and
    triggers compensation.
  - `step.sleep` for a post-delivery "rate your order" message or a reservation hold window.
  - Cloudflare's invoice sample adds a constant-backoff retry loop over D1 and an email step.
- **Verdict**: the most realistic example. Its first step is the most latency-sensitive, and it
  is already the example Cloudflare uses in its rollback docs.

### 4. Human-in-the-loop verification / approval

Sources: [Azure Durable Functions human interaction pattern (SMS phone verification)](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-human-interaction)
([`PhoneVerification.cs`](https://github.com/Azure/azure-functions-durable-extension/blob/dev/samples/precompiled/PhoneVerification.cs));
[Temporal `expense`](https://github.com/temporalio/samples-typescript/blob/main/expense/src/workflows.ts);
[Inngest invoice review `waitForEvent`](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event);
[Cloudflare image-tagging `waitForEvent`](https://developers.cloudflare.com/workflows/examples/wait-for-event/).

- **Steps (Azure)**: send an SMS code → race a 90 s timer against up to 4 `SmsChallengeResponse`
  events → return `authorized`.
- **Steps (Temporal expense)**: create the expense → wait for approve/reject or a timeout → pay.
- **Compensation**: none. A timeout or rejection simply ends the run.
- **Latency-sensitive first step**: **yes for the SMS/OTP case**. The user stares at the screen
  waiting for the code to arrive, and start latency adds directly to that wait.
- **Fakes**: trivial. The "SMS" is a write to a DO or KV, and the test harness reads the code back
  and calls `sendEvent`.
- **Feature coverage**: `waitForEvent` with a timeout, `step.do`. There is no rollback, and
  `sleep` is optional.
- **Note**: an approval workflow would wait in `waitForEvent` twice: once while parked in the pool
  and once for the approval. That is a good test that the pool's park step does not interfere with
  the workflow's own events (use distinct event `type`s).
- **Verdict**: a good secondary scenario if we want a pure `waitForEvent` demo. Too thin to be the
  main benchmark workflow.

### 5. Food delivery (Temporal)

Source: [Temporal `food-delivery` `order.ts`](https://github.com/temporalio/samples-typescript/blob/main/food-delivery/packages/workflows/order.ts).

- **Steps**: charge customer → wait for a `pickedUp` signal (1 min) → notify → wait for a
  `delivered` signal (1 min) → notify → sleep → ask for a rating.
- **Compensation**: if a wait times out, refund and notify. If the charge fails, notify and fail.
- **Latency-sensitive first step**: yes (the charge happens at "Place order").
- **Fakes**: easy. A payment stub, a push-notification log in a DO, and a harness that sends the
  courier signals.
- **Feature coverage**: excellent for `waitForEvent` with timeouts and for `sleep`, with
  compensation as a branch. The sample relies on Temporal **queries** for live state, which
  Workflows lacks; we would substitute `instance.status()` or a DO.
- **Verdict**: a strong demo, but it overlaps heavily with checkout and has more moving parts.

### 6. One-click buy with a cancel window (Temporal)

Source: [Temporal `nextjs-ecommerce-oneclick`](https://github.com/temporalio/samples-typescript/blob/main/nextjs-ecommerce-oneclick/temporal/src/workflows.ts).

- **Steps**: wait up to 5 s for a `cancelPurchase` signal → `checkoutItem` or `canceledPurchase`.
- **Latency-sensitive**: indirectly. The 5 s grace window starts when the workflow starts, so a
  slow start silently shortens the user's real undo window, or delays the purchase. This makes a
  neat illustration of start latency that users can see.
- **Feature coverage**: only `waitForEvent` with a timeout. Too small to stand on its own; it
  could be the first stage of checkout.

### 7. Payment with sync/async completion (Restate + Stripe)

Source: [Restate `signalspayments/payment_service.ts`](https://github.com/restatedev/examples/blob/main/typescript/patterns-use-cases/src/signalspayments/payment_service.ts).

- **Steps**: create a payment intent with a deterministic idempotency key. If the result is
  `processing`, wait for the webhook; otherwise it is done.
- **Latency-sensitive**: yes; this sample is about giving the user a fast synchronous answer.
- **Feature coverage**: `step.do` idempotency and `waitForEvent` on the slow path. Useful as the
  _payment step_ inside checkout rather than as a standalone workflow.

### 8. Cloudflare "Pay cart and send invoice"

Source: [Cloudflare example](https://developers.cloudflare.com/workflows/examples/send-invoices/).

- **Steps**: `sleep 10s` → poll D1 for checkout (10 constant 2 min retries) → POST to a payment
  processor (10 retries, 1 min apart) → send an invoice email (10 retries, 5 min apart).
- **Compensation**: none.
- **Latency-sensitive first step**: **no**. The first step is a sleep, and the workflow is
  explicitly asynchronous.
- **Verdict**: a good reference for retry configuration, but a poor fit for a start-latency
  benchmark.

### Two-phase commit

None of the durable-execution vendors surveyed (Temporal, Restate, DBOS, Inngest, Cloudflare)
ships a canonical "2PC" sample. The AWS and Azure pattern docs present sagas as the
_alternative_ to 2PC across services. The practical 2PC-like shape is **try-confirm-cancel**:
reserve (prepare) → pivot (pay) → confirm (commit), or cancel the reservations. Candidate 2's
cdk-patterns variant and candidate 3's reservation + payment pivot both have this shape, so a
dedicated 2PC example would add little.

## Comparison

| Candidate          | Compensation          | First step user-blocking | Fakes needed                     | `step.do` retries | rollback | `sleep`  | `waitForEvent`      |
| ------------------ | --------------------- | ------------------------ | -------------------------------- | ----------------- | -------- | -------- | ------------------- |
| Money transfer     | refund                | yes                      | Account DO ×2                    | ✓                 | ✓        | –        | (add-on)            |
| Trip booking (TCC) | 3–4 cancels           | moderate                 | Flights/Hotels/Cars/Payments DOs | ✓                 | ✓✓       | hold TTL | payment webhook     |
| Checkout / order   | release stock, cancel | **yes, by design**       | Inventory DO, D1, payment stub   | ✓                 | ✓        | ✓        | ✓ payment + timeout |
| SMS verification   | none                  | yes                      | DO/KV                            | ✓                 | –        | –        | ✓✓                  |
| Food delivery      | refund on timeout     | yes                      | payment stub, DO                 | ✓                 | ✓        | ✓        | ✓✓                  |
| One-click buy      | cancel branch         | indirectly (undo window) | none                             | –                 | –        | –        | ✓                   |
| Pay cart + invoice | none                  | no                       | D1, fetch, email                 | ✓✓                | –        | ✓        | –                   |

## Recommendations (ranked)

1. **Checkout / order saga, modelled on DBOS widget store + AWS orchestration + Cloudflare's
   `OrderWorkflow`.** This is the primary benchmark and demo workflow.
   - **Shape**: `reserve-inventory` (rollback: release) → `create-order` (rollback: cancel) →
     `waitForEvent("payment", timeout)` → `capture-payment` (the pivot; `NonRetryableError` on
     decline) → `confirm-order` → `sleep` → `send-receipt`.
   - **Why it ranks first**:
     - The first business step is exactly what a shopper waits on, so the pool's benefit is
       easy to explain.
     - It covers every Workflows primitive, including native rollback.
     - Its fakes are cheap and deterministic: an `Inventory` DO per SKU and a payment stub that
       calls `sendEvent`.
     - Cloudflare's own docs use the same domain.
   - **Benchmark point**: measure up to the first step's side effect (stock reserved). The rest
     of the run is there for demo realism and must not be part of the start-latency numbers.
2. **Money transfer.** This is the minimal control workload: two DO calls, a
   `NonRetryableError` for insufficient funds, and one rollback.
   - **Why**: the step bodies are nearly free, so cold vs pre-started start cost is measured with
     the least noise. It is also the first sample Temporal shows newcomers.
   - **Use**: run it as the baseline workload in the same benchmark run as checkout.
3. **Trip booking (try-confirm-cancel form).** This is the compensation-heavy demo: reserve
   flight, hotel, and car → pay → confirm all, with reverse-order cancels and a reservation hold
   implemented with `step.sleep`.
   - **Why**: it is the textbook saga (Garcia-Molina; McCaffrey; AWS, Restate, and Camunda
     samples) and the closest of these samples to 2PC. It stress-tests rollback ordering.
     However, its user-facing latency comes from the whole chain, so it is weaker evidence for
     the start-cost thesis.

The **SMS verification** flow is the best alternative if we later want a scenario focused on
`waitForEvent`. It also tests that the pool's park event does not collide with a workflow's own
events.

### Implementation notes for whichever we pick

- **Failure injection**: drive it from the payload, e.g. `{ failAt?: "inventory" | "payment" | "confirm", failKind: "transient" | "terminal" }`.
  This follows Restate's `shouldThrow` and cdk-patterns' `run_type`, and lets one deployed
  Worker produce success, retry, and compensation runs.
- **Idempotent fakes**: make every fake idempotent, keyed by instance id. Steps and rollback
  handlers are retried, so this follows [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
- **Same steps on both paths**: the cold path and the pool path must run identical business
  steps. The only difference is how the payload arrives: `create({ params })` for the cold path,
  and parked `waitForEvent` + `sendEvent` for the pool path. The first business step should
  record a timestamp in a DO so that "first step executing" is measured separately from
  `create()` resolving.
