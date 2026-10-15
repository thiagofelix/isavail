import * as Alchemy from "alchemy";
import { Effect } from "effect";
import { OBSERVABILITY_STAGE, ObservabilityStack } from "./observability-stack.ts";

/**
 * The observability Stack at {@link OBSERVABILITY_STAGE}. Alchemy's stage
 * lookup is typed as possibly missing, but it builds a reference for any
 * stage name, so the fallback is never taken.
 */
const observabilityStackReference = Effect.suspend(
  () =>
    ObservabilityStack.stage[OBSERVABILITY_STAGE] ??
    Effect.die(new Error(`Alchemy built no reference to stage "${OBSERVABILITY_STAGE}".`)),
);

/**
 * Standard OpenTelemetry environment variables that export a program's traces
 * and logs to the Axiom datasets of the observability Stack.
 *
 * Every stage, `alchemy dev` included, exports to the same datasets. The
 * resource attributes `alchemy.stack` and `alchemy.stage` identify the
 * exporting Stack and stage (the same names Alchemy's Worker exporter uses),
 * so queries select a stage by filtering on `alchemy.stage`.
 *
 * `variables` hold no credentials. `secrets` carry the ingest token and must
 * be bound as secrets: `Redacted` Worker env values or Fly secrets.
 *
 * The values are Outputs of the observability Stack. Like any Stack
 * reference, they are only descriptions until Alchemy resolves them while
 * deploying, so this also runs inside deployed bundles without touching
 * deployment state.
 */
export const telemetryExportVariables = (serviceName: string) =>
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    const destination = yield* observabilityStackReference;

    return {
      variables: {
        OTEL_SERVICE_NAME: serviceName,
        OTEL_RESOURCE_ATTRIBUTES:
          `alchemy.stack=${encodeURIComponent(stack.name)},` +
          `alchemy.stage=${encodeURIComponent(stack.stage)}`,
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: destination.tracesEndpoint,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: destination.logsEndpoint,
      },
      secrets: {
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: destination.tracesHeaders,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: destination.logsHeaders,
      },
    };
  });
