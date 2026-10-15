import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";
import { relayHttpApiLayer } from "./relay-http-server.ts";

/** `service.name` of the relay's traces and logs. */
export const RELAY_TELEMETRY_SERVICE_NAME = "isavail-registry-relay";

/**
 * OpenTelemetry trace and log exporters for the relay process, configured by
 * the standard `OTEL_*` variables the relay Stack sets
 * (`telemetryExportVariables` in `@isavail/shared-infrastructure`).
 *
 * Fly.io Services do not get Alchemy's built-in exporter, so the relay
 * installs Effect's own. Exports are batched on an interval for the life of
 * the process and flushed when the scope that built the layer closes. Without
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_TRACES_EXPORTER=otlp` (and the
 * `LOGS` equivalents) the layer exports nothing.
 */
const relayTelemetryLayer = Layer.mergeAll(
  OtlpTracer.layerFromConfig(),
  OtlpLogger.layerFromConfig(),
).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

/**
 * The relay HTTP app, traced and logged through {@link relayTelemetryLayer}.
 *
 * The exporters are provided twice on purpose. Effect's HTTP API handlers run
 * with the context their routes were built in, so the routes are built under
 * the exporters; the router's `http.server` span reads the tracer of the
 * request fiber, so every request runs under them too. That span continues
 * the caller's `traceparent`, which joins the relay's spans to the API
 * Worker's trace.
 */
export const tracedRelayHttpApp = Effect.gen(function* () {
  const telemetry = yield* Layer.build(relayTelemetryLayer);
  const httpApp = yield* HttpRouter.toHttpEffect(relayHttpApiLayer).pipe(
    Effect.provideContext(telemetry),
  );

  return httpApp.pipe(Effect.provideContext(telemetry));
});
