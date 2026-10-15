/**
 * Axiom datasets and ingest tokens of the observability Stack.
 *
 * Only `alchemy.run.ts` imports this module, so Worker and relay bundles never
 * include the Axiom provider.
 */
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import { Effect, Redacted } from "effect";

/** Settings that differ between the production and the preview destination. */
interface TelemetryEnvironment {
  /** Lowercase name used in the Axiom dataset and token names. */
  readonly name: "production" | "preview";
  /** Prefix of the logical resource IDs. */
  readonly logicalIdPrefix: "Production" | "Preview";
  /** Who exports into the destination, for the Axiom descriptions. */
  readonly exporters: string;
  readonly retentionDays: number;
}

const PRODUCTION: TelemetryEnvironment = {
  name: "production",
  logicalIdPrefix: "Production",
  exporters: "stage production",
  retentionDays: 30,
};

const PREVIEW: TelemetryEnvironment = {
  name: "preview",
  logicalIdPrefix: "Preview",
  exporters: "every stage other than production, local development included",
  retentionDays: 7,
};

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
 * Creates one environment's traces and logs datasets and an ingest token that
 * can write to those two datasets and nothing else.
 *
 * Datasets are retained when the Stack is destroyed, so their data survives;
 * tokens are deleted.
 */
const provisionTelemetryDestination = (environment: TelemetryEnvironment) =>
  Effect.gen(function* () {
    const traces = yield* Axiom.Dataset(`${environment.logicalIdPrefix}Traces`, {
      name: `isavail-${environment.name}-traces`,
      kind: "otel:traces:v1",
      description: `isavail OpenTelemetry traces from ${environment.exporters}.`,
      retentionDays: environment.retentionDays,
      useRetentionPeriod: true,
    }).pipe(Alchemy.RemovalPolicy.retain());

    const logs = yield* Axiom.Dataset(`${environment.logicalIdPrefix}Logs`, {
      name: `isavail-${environment.name}-logs`,
      kind: "otel:logs:v1",
      description: `isavail OpenTelemetry logs from ${environment.exporters}.`,
      retentionDays: environment.retentionDays,
      useRetentionPeriod: true,
    }).pipe(Alchemy.RemovalPolicy.retain());

    const ingestToken = yield* Axiom.ApiToken(`${environment.logicalIdPrefix}IngestToken`, {
      name: `isavail-${environment.name}-telemetry-ingest`,
      description: `Ingest-only token for the isavail ${environment.name} telemetry datasets.`,
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

/** Destination of stage `production`. */
export const ProductionTelemetryDestination = provisionTelemetryDestination(PRODUCTION);

/** Destination shared by every other stage, local development included. */
export const PreviewTelemetryDestination = provisionTelemetryDestination(PREVIEW);
