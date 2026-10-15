/**
 * Runs the relay on a developer machine at `LOCAL_REGISTRY_RELAY_URL`.
 *
 * Alchemy has no local provider for Fly.io, so under `alchemy dev` the relay
 * Stack runs this program with `Command.Dev` instead of deploying a Machine. It
 * serves the same routes, exports traces and logs through the same `OTEL_*`
 * variables, and talks to the real Registro.br, which no stage can emulate.
 */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  LOCAL_REGISTRY_RELAY_ACCESS_TOKEN,
  LOCAL_REGISTRY_RELAY_PORT,
  REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE,
} from "@isavail/availability-contract";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { HttpServer } from "effect/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.layer takes node:http's createServer.
import { createServer } from "node:http";
import { tracedRelayHttpApp } from "./relay-telemetry.ts";

const localAccessTokenConfig = ConfigProvider.fromEnv().pipe(
  ConfigProvider.orElse(
    ConfigProvider.fromUnknown({
      [REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE]: Redacted.value(LOCAL_REGISTRY_RELAY_ACCESS_TOKEN),
    }),
  ),
);

const localRelayServerLayer = Layer.effectDiscard(
  Effect.flatMap(tracedRelayHttpApp, HttpServer.serveEffect()),
).pipe(
  HttpServer.withLogAddress,
  Layer.provide(
    NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: LOCAL_REGISTRY_RELAY_PORT }),
  ),
  Layer.provide(ConfigProvider.layer(localAccessTokenConfig)),
);

Layer.launch(localRelayServerLayer).pipe(NodeRuntime.runMain);
