/**
 * Axiom datasets and ingest token of the observability Stack.
 *
 * Only `alchemy.run.ts` imports this module, so Worker and relay bundles never
 * include the Axiom provider.
 */
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import { Effect, Redacted } from "effect";

/** Days Axiom keeps traces and logs; the most the Personal plan allows. */
const RETENTION_DAYS = 30;

/**
 * OTLP headers for one dataset, in the `OTEL_EXPORTER_OTLP_HEADERS` format:
 * the bearer ingest token and Axiom's dataset routing header.
 */
const otlpHeaders = (
  ingestToken: Output.Output<Redacted.Redacted<string>>,
  datasetName: Output.Output<string>,
): Output.Output<Redacted.Redacted<string>> =>
  Output.all(ingestToken, datasetName).pipe(
    Output.map(([token, dataset]) =>
      Redacted.make(
        `Authorization=${encodeURIComponent(`Bearer ${Redacted.value(token)}`)},` +
          `X-Axiom-Dataset=${encodeURIComponent(dataset)}`,
      ),
    ),
  );

/**
 * Traces from every stage; the `alchemy.stage` resource attribute tells stages
 * apart. Retained when the Stack is destroyed, so the data survives.
 */
export const TracesDataset = Axiom.Dataset("Traces", {
  name: "isavail-traces",
  kind: "otel:traces:v1",
  description: "isavail OpenTelemetry traces from every stage; filter on alchemy.stage.",
  retentionDays: RETENTION_DAYS,
  useRetentionPeriod: true,
}).pipe(Alchemy.RemovalPolicy.retain());

/** Logs from every stage, retained like {@link TracesDataset}. */
export const LogsDataset = Axiom.Dataset("Logs", {
  name: "isavail-logs",
  kind: "otel:logs:v1",
  description: "isavail OpenTelemetry logs from every stage; filter on alchemy.stage.",
  retentionDays: RETENTION_DAYS,
  useRetentionPeriod: true,
}).pipe(Alchemy.RemovalPolicy.retain());

/**
 * Where every stage exports: both datasets and an ingest token that can write
 * to those two datasets and nothing else. The token is deleted when the Stack
 * is destroyed.
 *
 * Traces and logs need separate datasets because a dataset's kind fixes the
 * one OpenTelemetry signal it accepts.
 */
export const TelemetryDestination = Effect.gen(function* () {
  const traces = yield* TracesDataset;
  const logs = yield* LogsDataset;

  const ingestToken = yield* Axiom.ApiToken("IngestToken", {
    name: "isavail-telemetry-ingest",
    description: "Ingest-only token for the isavail traces and logs datasets.",
    // Keyed by the dataset Outputs rather than literal names so Alchemy
    // creates the token after the datasets exist.
    datasetCapabilities: Output.all(traces.name, logs.name).pipe(
      Output.map(([tracesName, logsName]) => ({
        [tracesName]: { ingest: ["create"] },
        [logsName]: { ingest: ["create"] },
      })),
    ),
  });

  return {
    tracesEndpoint: traces.otelTracesEndpoint,
    tracesHeaders: otlpHeaders(ingestToken.token, traces.name),
    logsEndpoint: logs.otelLogsEndpoint,
    logsHeaders: otlpHeaders(ingestToken.token, logs.name),
  };
});
