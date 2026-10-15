import { TELEMETRY_SERVICE_NAMES } from "@isavail/shared-infrastructure";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";
import { relayHttpApiLayer } from "./relay-http-server.ts";

/** `service.name` of the relay's traces and logs. */
export const RELAY_TELEMETRY_SERVICE_NAME = TELEMETRY_SERVICE_NAMES.registryRelay;

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
 * the exporters. Every request then runs under them too, which the server span
 * needs.
 *
 * The server span comes from `HttpMiddleware.tracer`, applied here rather than
 * by the HTTP server. Effect's server traces a request only when the server's
 * own fiber has a tracer, and the server fiber belongs to Alchemy's Fly
 * runtime (or to `relay-local-server.ts`), where no exporter is installed. The
 * middleware continues the caller's `traceparent`, which joins the relay's
 * spans to the API Worker's trace.
 *
 * @internal
 */
export const tracedRelayHttpApp = Effect.gen(function* () {
  const telemetry = yield* Layer.build(relayTelemetryLayer);
  const httpApp = yield* HttpRouter.toHttpEffect(relayHttpApiLayer).pipe(
    Effect.provideContext(telemetry),
  );

  // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- The result is the HTTP app itself, which callers serve.
  return HttpMiddleware.tracer(httpApp).pipe(Effect.provideContext(telemetry));
});
