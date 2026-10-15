import {
  REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE,
  RegistryRelayHttpApi,
  RelayAccessDenied,
  RelayAuthorization,
} from "@isavail/availability-contract";
import { Config, Effect, Layer, Redacted } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { timingSafeEqual } from "node:crypto";
import { IsavailClient, isavailClientLayer } from "./isavail-client.ts";

const accessTokensMatch = (
  presented: Redacted.Redacted<string>,
  expected: Redacted.Redacted<string>,
): boolean => {
  const presentedBytes = Buffer.from(Redacted.value(presented));
  const expectedBytes = Buffer.from(Redacted.value(expected));

  return (
    presentedBytes.length === expectedBytes.length && timingSafeEqual(presentedBytes, expectedBytes)
  );
};

/**
 * Admits a request only when its bearer credential is the relay access token.
 *
 * The token is read from {@link REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE} on each
 * request rather than while the relay starts, because Alchemy also evaluates
 * the relay program while planning a deployment, where the token does not
 * exist. A relay started without the token rejects nothing silently: the
 * request fails as a defect and the relay logs the missing configuration.
 */
export const relayAuthorizationLayer = Layer.succeed(
  RelayAuthorization,
  RelayAuthorization.of({
    bearer: Effect.fn("RelayAuthorization.bearer")(function* (httpEffect, { credential }) {
      const expected = yield* Config.Redacted(REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE).pipe(
        Effect.orDie,
      );

      if (!accessTokensMatch(credential, expected)) {
        return yield* new RelayAccessDenied({
          message:
            "The relay access token is missing or does not match. Send the token the relay Stack published as a bearer credential.",
        });
      }

      return yield* httpEffect;
    }),
  }),
);

const registryLookupsHandlersLayer = HttpApiBuilder.group(
  RegistryRelayHttpApi,
  "registryLookups",
  (handlers) =>
    Effect.gen(function* () {
      const client = yield* IsavailClient;

      return handlers.handle("lookUpDomains", ({ payload }) =>
        client.lookUpDomains(payload.domainNames).pipe(Effect.map((lookups) => ({ lookups }))),
      );
    }),
);

const systemHandlersLayer = HttpApiBuilder.group(RegistryRelayHttpApi, "system", (handlers) =>
  Effect.succeed(handlers.handle("checkHealth", () => Effect.void)),
);

/**
 * Relay endpoint handlers and their access check, backed by the contextual
 * ISAVAIL client. The caller provides `IsavailClient`.
 */
export const relayHttpHandlersLayerWithoutDependencies = Layer.mergeAll(
  registryLookupsHandlersLayer,
  systemHandlersLayer,
).pipe(Layer.provideMerge(relayAuthorizationLayer));

/** Relay HTTP routes backed by Registro.br, ready to serve. */
export const relayHttpApiLayer = HttpApiBuilder.layer(RegistryRelayHttpApi).pipe(
  Layer.provide(relayHttpHandlersLayerWithoutDependencies),
  Layer.provide(isavailClientLayer),
  Layer.provide(HttpServer.layerServices),
);
