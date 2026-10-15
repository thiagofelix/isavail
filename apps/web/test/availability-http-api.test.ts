import { BrowserCrypto } from "@effect/platform-browser";
import { assert, describe, layer } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import { Array, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { availabilityCheckerTestLayer } from "../src/api/availability-checker.ts";
import { AvailabilityHttpApi } from "../src/api/availability-http-api.ts";
import { availabilityHttpHandlersLayerWithoutDependencies } from "../src/api/availability-http-handlers.ts";

const routesLayer = availabilityHttpHandlersLayerWithoutDependencies.pipe(
  Layer.provide([availabilityCheckerTestLayer, BrowserCrypto.layer]),
  HttpRouter.provideRequest(RuntimeContext.phantom),
  Layer.merge(HttpServer.layerServices),
);

const makeClient = HttpApiTest.groups(AvailabilityHttpApi, ["domainAvailability"]);

layer(routesLayer)("Availability HTTP API", (it) => {
  describe("POST /v1/availability-checks", () => {
    it.effect("checks each distinct domain once, in first-requested order", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;

        const report = yield* client.domainAvailability.checkDomains({
          payload: { domains: ["MinhaEmpresa", "gov.com.br", "https://minhaempresa.com.br/"] },
        });

        assert.match(report.requestId, /^req_/);
        assert.deepStrictEqual(
          Array.map(report.checks, (check) => check.domainName),
          ["minhaempresa.com.br", "gov.com.br"],
        );
      }),
    );

    it.effect("rejects the request with every entry that is not a .br domain", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;

        const error = yield* client.domainAvailability
          .checkDomains({ payload: { domains: ["minhaempresa", "minha_empresa", "exemplo.com"] } })
          .pipe(Effect.flip);

        if (error._tag !== "InvalidDomainNames") {
          return assert.fail(`Expected InvalidDomainNames, received ${error._tag}`);
        }

        assert.strictEqual(error.retryable, false);
        assert.deepStrictEqual(
          Array.map(error.details.violations, ({ input }) => input),
          ["minha_empresa", "exemplo.com"],
        );
      }),
    );
  });

  describe("GET /v1/domains/:domain/availability", () => {
    it.effect("checks one domain given as a bare company name", () =>
      Effect.gen(function* () {
        const client = yield* makeClient;

        const report = yield* client.domainAvailability.checkDomain({
          params: { domain: "registro.br" },
        });

        assert.deepStrictEqual(
          Array.map(report.checks, (check) =>
            check._tag === "Checked" ? check.availability._tag : check._tag,
          ),
          ["Registered"],
        );
      }),
    );
  });
});
