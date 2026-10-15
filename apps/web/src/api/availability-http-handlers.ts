import { type DomainName, parseDomainNameInput } from "@isavail/availability-contract";
import { BrowserCrypto } from "@effect/platform-browser";
import { Crypto, Effect, Layer, Result } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import * as AlchemyHttp from "alchemy/Http";
import { AvailabilityChecker, availabilityCheckerLayer } from "./availability-checker.ts";
import {
  AvailabilityHttpApi,
  type DomainNameViolation,
  InvalidDomainNames,
  OPENAPI_PATH,
  RequestId,
} from "./availability-http-api.ts";

const newRequestId = (crypto: Crypto.Crypto) =>
  crypto.randomUUIDv4().pipe(
    Effect.map((uuid) => RequestId.make(`req_${uuid}`)),
    // Web Crypto failing to produce randomness is a broken runtime, not a request error.
    Effect.orDie,
  );

const pluralizeEntries = (count: number) => (count === 1 ? "1 entry is" : `${count} entries are`);

/**
 * Parses requested entries into distinct domain names in first-requested
 * order, or fails with every entry that is not a `.br` domain name.
 */
const parseRequestedDomains = (inputs: ReadonlyArray<string>, requestId: RequestId) =>
  Effect.gen(function* () {
    const domainNames: Array<DomainName> = [];
    const violations: Array<DomainNameViolation> = [];

    for (const input of inputs) {
      const parsed = yield* Effect.result(parseDomainNameInput(input));

      if (Result.isSuccess(parsed)) {
        if (!domainNames.includes(parsed.success)) {
          domainNames.push(parsed.success);
        }
      } else {
        violations.push({ input, message: parsed.failure.message });
      }
    }

    if (violations.length > 0) {
      return yield* InvalidDomainNames.make({
        code: "InvalidDomainNames",
        message: `${pluralizeEntries(violations.length)} not a .br domain name, so nothing was checked. Correct or remove the entries listed in details.violations and send the request again.`,
        requestId,
        retryable: false,
        details: { violations },
      });
    }

    return domainNames;
  });

/**
 * Public endpoint handlers backed by the contextual availability checker. The
 * caller provides `AvailabilityChecker` and `Crypto`.
 *
 * @internal
 */
export const availabilityHttpHandlersLayerWithoutDependencies = HttpApiBuilder.group(
  AvailabilityHttpApi,
  "domainAvailability",
  (handlers) =>
    Effect.gen(function* () {
      const checker = yield* AvailabilityChecker;
      const crypto = yield* Crypto.Crypto;

      const checkRequestedDomains = Effect.fn("AvailabilityHttpApi.checkRequestedDomains")(
        function* (inputs: ReadonlyArray<string>) {
          const requestId = yield* newRequestId(crypto);
          yield* Effect.annotateCurrentSpan("request.id", requestId);

          const domainNames = yield* parseRequestedDomains(inputs, requestId);
          const checks = yield* checker.checkDomains(domainNames);

          return { requestId, checks };
        },
      );

      return handlers
        .handle("checkDomains", ({ payload }) => checkRequestedDomains(payload.domains))
        .handle("checkDomain", ({ params }) => checkRequestedDomains([params.domain]));
    }),
);

/**
 * Public API routes, including the OpenAPI document, over Workers KV and the deployed relay.
 *
 * @internal
 */
export const availabilityHttpApiLayer = HttpApiBuilder.layer(AvailabilityHttpApi, {
  openapiPath: OPENAPI_PATH,
}).pipe(
  Layer.provide(availabilityHttpHandlersLayerWithoutDependencies),
  Layer.provide([availabilityCheckerLayer, BrowserCrypto.layer]),
  Layer.provide(AlchemyHttp.Platform),
);
