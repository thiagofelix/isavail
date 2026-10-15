import { REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE } from "@isavail/availability-contract";
import { telemetryExportVariables } from "@isavail/shared-infrastructure";
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import { Effect } from "effect";
import { RELAY_TELEMETRY_SERVICE_NAME, tracedRelayHttpApp } from "./relay-telemetry.ts";

/** Port the relay process listens on inside its Fly Machine. */
const RELAY_PORT = 8080;

/**
 * Fly App that owns the relay Machine, its public addresses, and its access
 * token secret. The relay needs an App of its own because Fly injects App
 * secrets into every Machine of the App.
 */
export const RegistryRelayApp = Fly.App("RegistryRelayApp");

/** Free shared IPv4 address so the relay answers at `https://{app}.fly.dev`. */
export const RegistryRelayPublicAddress = Fly.IpAssignment("RegistryRelayPublicAddress", {
  app: RegistryRelayApp,
  type: "shared_v4",
});

/** Bearer token the web app's API Worker presents to the relay. Generated once and kept in state. */
export const RegistryRelayAccessToken = Alchemy.Random("RegistryRelayAccessToken");

/** Fly secret that hands the access token to the relay process as an environment variable. */
export const RegistryRelayAccessTokenSecret = Effect.gen(function* () {
  const accessToken = yield* RegistryRelayAccessToken;

  return yield* Fly.Secret("RegistryRelayAccessTokenSecret", {
    app: RegistryRelayApp,
    name: REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE,
    value: accessToken.text,
  });
});

/**
 * Telemetry configuration of the relay Machine: the plain `OTEL_*` variables,
 * and the two header variables, which carry the Axiom ingest token, as Fly
 * secrets. Fly writes Machine `env` into the Machine config in plain text, so
 * the token must not go there.
 */
export const RegistryRelayTelemetry = Effect.gen(function* () {
  const telemetry = yield* telemetryExportVariables(RELAY_TELEMETRY_SERVICE_NAME);

  const tracesHeadersSecret = yield* Fly.Secret("RegistryRelayTracesHeadersSecret", {
    app: RegistryRelayApp,
    name: "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    value: telemetry.secrets.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
  });
  const logsHeadersSecret = yield* Fly.Secret("RegistryRelayLogsHeadersSecret", {
    app: RegistryRelayApp,
    name: "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    value: telemetry.secrets.OTEL_EXPORTER_OTLP_LOGS_HEADERS,
  });

  return {
    variables: telemetry.variables,
    tracesHeadersDigest: tracesHeadersSecret.digest,
    logsHeadersDigest: logsHeadersSecret.digest,
  };
});

/**
 * The Registro.br relay: one Fly Machine in São Paulo (`gru`), next to
 * Registro.br, with the stable source address Registro.br rate-limits.
 *
 * It runs a single Machine because Registro.br issues its cookie and its query
 * budget per source address; a second Machine would need a shared rate-limit
 * store.
 */
export default class RegistryRelayService extends Fly.Service<RegistryRelayService>()(
  "RegistryRelay",
  Effect.gen(function* () {
    const accessTokenSecret = yield* RegistryRelayAccessTokenSecret;
    const telemetry = yield* RegistryRelayTelemetry;

    return {
      app: RegistryRelayApp,
      main: import.meta.url,
      region: "gru",
      count: 1,
      port: RELAY_PORT,
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
      env: {
        ...telemetry.variables,
        // NOTE: Fly applies a changed App secret to a Machine only when the
        // Machine is updated, so the digests are part of the Machine config.
        ISAVAIL_RELAY_ACCESS_TOKEN_DIGEST: accessTokenSecret.digest,
        ISAVAIL_RELAY_TRACES_HEADERS_DIGEST: telemetry.tracesHeadersDigest,
        ISAVAIL_RELAY_LOGS_HEADERS_DIGEST: telemetry.logsHeadersDigest,
      },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: yield* tracedRelayHttpApp,
    };
  }),
) {}
