import { type DomainName, parseDomainNameInput } from "@isavail/availability-contract";
import { Effect, Layer, Result } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import * as AlchemyHttp from "alchemy/Http";
import { AvailabilityChecker, availabilityCheckerLayer } from "./availability-checker.ts";
import {
  AvailabilityHttpApi,
  type DomainNameViolation,
  InvalidDomainNames,
  RequestId,
} from "./availability-http-api.ts";

/** Path the API serves its generated OpenAPI document on. */
export const OPENAPI_PATH = "/v1/openapi.json";

const newRequestId = Effect.sync(() => RequestId.make(`req_${crypto.randomUUID()}`));

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
      return yield* new InvalidDomainNames({
        code: "InvalidDomainNames",
        message: `${pluralizeEntries(violations.length)} not a .br domain name, so nothing was checked. Correct or remove the entries listed in details.violations and send the request again.`,
        requestId,
        retryable: false,
        details: { violations },
      });
    }

    return domainNames;
  });

/** Public endpoint handlers backed by the contextual availability checker. */
export const availabilityHttpHandlersLayerWithoutDependencies = HttpApiBuilder.group(
  AvailabilityHttpApi,
  "domainAvailability",
  (handlers) =>
    Effect.gen(function* () {
      const checker = yield* AvailabilityChecker;

      const checkRequestedDomains = Effect.fn("AvailabilityHttpApi.checkRequestedDomains")(
        function* (inputs: ReadonlyArray<string>) {
          const requestId = yield* newRequestId;
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

/** Public API routes, including the OpenAPI document, over Workers KV and the deployed relay. */
export const availabilityHttpApiLayer = HttpApiBuilder.layer(AvailabilityHttpApi, {
  openapiPath: OPENAPI_PATH,
}).pipe(
  Layer.provide(availabilityHttpHandlersLayerWithoutDependencies),
  Layer.provide(availabilityCheckerLayer),
  Layer.provide(AlchemyHttp.Platform),
);
