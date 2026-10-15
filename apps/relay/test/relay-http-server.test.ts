import {
  DomainName,
  REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE,
  RegistryRelayHttpApi,
  RelayAuthorization,
} from "@isavail/availability-contract";
import { assert, describe, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClientRequest, HttpServer } from "effect/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api";
import { isavailClientTestLayer } from "../src/isavail-client.ts";
import { relayHttpHandlersLayerWithoutDependencies } from "../src/relay-http-server.ts";

const RELAY_ACCESS_TOKEN = "relay-test-token";

const relayRoutesLayer = relayHttpHandlersLayerWithoutDependencies.pipe(
  Layer.provide(isavailClientTestLayer),
  Layer.merge(HttpServer.layerServices),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ [REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE]: RELAY_ACCESS_TOKEN }),
    ),
  ),
);

const presentingToken = (token: string) =>
  HttpApiMiddleware.layerClient(RelayAuthorization, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token)),
  );

const makeRelayClient = HttpApiTest.groups(RegistryRelayHttpApi, ["registryLookups"]);

layer(relayRoutesLayer)("Registro.br relay HTTP API", (it) => {
  describe("POST /v1/lookups", () => {
    it.effect("returns one lookup per requested domain in request order", () =>
      Effect.gen(function* () {
        const client = yield* makeRelayClient;

        const { lookups } = yield* client.registryLookups.lookUpDomains({
          payload: {
            domainNames: [DomainName.make("gov.com.br"), DomainName.make("livre.com.br")],
          },
        });

        assert.deepStrictEqual(
          lookups.map((lookup) =>
            lookup._tag === "Resolved" ? [lookup.domainName, lookup.availability._tag] : [],
          ),
          [
            ["gov.com.br", "Unavailable"],
            ["livre.com.br", "Available"],
          ],
        );
      }).pipe(Effect.provide(presentingToken(RELAY_ACCESS_TOKEN))),
    );

    it.effect("rejects a caller without the relay access token", () =>
      Effect.gen(function* () {
        const client = yield* makeRelayClient;

        const error = yield* client.registryLookups
          .lookUpDomains({ payload: { domainNames: [DomainName.make("livre.com.br")] } })
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "RelayAccessDenied");
      }).pipe(Effect.provide(presentingToken("wrong-token"))),
    );
  });
});
