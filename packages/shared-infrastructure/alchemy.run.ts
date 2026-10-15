/**
 * Observability Stack: the Axiom traces and logs datasets, and their ingest
 * token, that every stage of the isavail apps exports to, plus the
 * "isavail traces" dashboard.
 *
 * It is a documented exception to per-stage isolation (`docs/observability.md`):
 * it exists only at stage `production`, every stage shares its datasets and
 * is told apart by the `alchemy.stage` resource attribute, and application
 * Stacks read its outputs through `ObservabilityStack.stage.production`. Deploy
 * it before any application stage; destroying it deletes the token and keeps
 * the datasets.
 */
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { TelemetryDestination } from "./src/axiom/telemetry-datasets.ts";
import { TracesDashboard } from "./src/axiom/traces-dashboard.ts";
import { OBSERVABILITY_STAGE, ObservabilityStack } from "./src/observability-stack.ts";

export default ObservabilityStack.make(
  {
    providers: Axiom.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    if (stage !== OBSERVABILITY_STAGE) {
      return yield* Effect.die(
        new Error(
          `The observability Stack exists only at stage "${OBSERVABILITY_STAGE}", not "${stage}". ` +
            `Run it with --stage ${OBSERVABILITY_STAGE} (vp run @isavail/shared-infrastructure#deploy).`,
        ),
      );
    }

    yield* TracesDashboard;

    return yield* TelemetryDestination;
  }),
);
