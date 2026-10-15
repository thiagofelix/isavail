import { TELEMETRY_SERVICE_NAMES, telemetryExportVariables } from "@isavail/shared-infrastructure";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { availabilityHttpApiLayer } from "./availability-http-handlers.ts";
import { registryRelayWorkerEnv } from "./registry-relay-connection.ts";

/**
 * The public availability API. The website forwards `/v1/*` to it through a
 * service binding, so browsers and Agents reach it on the website's own origin.
 *
 * Its traces and logs go to the Axiom destination of the stage. Alchemy's
 * Worker runtime installs an OTLP exporter for every request from the standard
 * `OTEL_*` bindings and flushes it in `waitUntil` after the response; the
 * header bindings carry the ingest token and are bound as secrets.
 */
export default class AvailabilityApiWorker extends Cloudflare.Worker<AvailabilityApiWorker>()(
  "AvailabilityApi",
  Effect.gen(function* () {
    const relayEnv = yield* registryRelayWorkerEnv;
    const telemetry = yield* telemetryExportVariables(TELEMETRY_SERVICE_NAMES.availabilityApi);

    return {
      main: import.meta.url,
      compatibility: { date: "2026-10-01" },
      env: { ...relayEnv, ...telemetry.variables, ...telemetry.secrets },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: yield* HttpRouter.toHttpEffect(availabilityHttpApiLayer),
    };
  }),
) {}
