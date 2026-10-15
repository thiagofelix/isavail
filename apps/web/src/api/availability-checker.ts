import type { DomainName, RegistryLookup } from "@isavail/availability-contract";
import type { RuntimeContext } from "alchemy";
import { Context, Effect, Layer, Option } from "effect";
import {
  AvailabilityCache,
  availabilityCacheLayer,
  availabilityCacheTestLayer,
  type RememberedAvailability,
} from "./availability-cache.ts";
import { DomainCheck, DomainCheckFailure } from "./availability-http-api.ts";
import {
  RegistryRelayClient,
  registryRelayClientLayer,
  registryRelayClientTestLayer,
} from "./registry-relay-client.ts";

/**
 * Checks whether `.br` domains can be registered. Checks read and write the
 * Worker's cache, so they run inside a Worker invocation (`RuntimeContext`).
 */
export interface IAvailabilityChecker {
  /**
   * Checks each domain, reusing fresh remembered answers and asking
   * Registro.br only about the rest.
   *
   * @param domainNames - Distinct domains to check.
   * @returns One check per domain in the order given. A domain that could not
   * be checked is `NotChecked`; the effect itself never fails.
   */
  readonly checkDomains: (
    domainNames: ReadonlyArray<DomainName>,
  ) => Effect.Effect<ReadonlyArray<DomainCheck>, never, RuntimeContext>;
}

/** Provides the contextual availability checker. */
export class AvailabilityChecker extends Context.Service<
  AvailabilityChecker,
  IAvailabilityChecker
>()("@isavail/web/AvailabilityChecker") {}

const rememberedCheck = (domainName: DomainName, remembered: RememberedAvailability): DomainCheck =>
  DomainCheck.cases.Checked.make({ domainName, ...remembered, servedFromCache: true });

const rememberedAnswerOf = (
  check: DomainCheck,
): ReadonlyArray<readonly [DomainName, RememberedAvailability]> =>
  check._tag === "Checked"
    ? [[check.domainName, { availability: check.availability, checkedAt: check.checkedAt }]]
    : [];

const lookupCheck = (lookup: RegistryLookup): DomainCheck =>
  lookup._tag === "Resolved"
    ? DomainCheck.cases.Checked.make({
        domainName: lookup.domainName,
        availability: lookup.availability,
        checkedAt: lookup.checkedAt,
        servedFromCache: false,
      })
    : DomainCheck.cases.NotChecked.make({ domainName: lookup.domainName, failure: lookup.failure });

/** Constructs the checker over the contextual cache and relay client. */
export const makeAvailabilityChecker = Effect.gen(function* () {
  const cache = yield* AvailabilityCache;
  const relay = yield* RegistryRelayClient;

  const askRegistro = (domainNames: ReadonlyArray<DomainName>) =>
    relay.lookUpDomains(domainNames).pipe(
      Effect.map((lookups) => lookups.map(lookupCheck)),
      Effect.catchTag("RegistryRelayUnavailable", (error) =>
        Effect.logError("Could not reach the Registro.br relay", error.reason, error.message).pipe(
          Effect.as(
            domainNames.map((domainName) =>
              DomainCheck.cases.NotChecked.make({
                domainName,
                failure: DomainCheckFailure.cases.LookupServiceUnavailable.make({}),
              }),
            ),
          ),
        ),
      ),
    );

  const checkDomains = Effect.fn("AvailabilityChecker.checkDomains")(function* (
    domainNames: ReadonlyArray<DomainName>,
  ) {
    const remembered = yield* cache.readAvailabilities(domainNames);
    const unknownDomainNames = domainNames.filter((domainName) => !remembered.has(domainName));
    const freshChecks =
      unknownDomainNames.length === 0 ? [] : yield* askRegistro(unknownDomainNames);
    const freshChecksByDomain = new Map(freshChecks.map((check) => [check.domainName, check]));

    yield* cache.rememberAvailabilities(freshChecks.flatMap(rememberedAnswerOf));

    yield* Effect.annotateCurrentSpan({
      "availability.domain_count": domainNames.length,
      "availability.cached_count": remembered.size,
    });

    return domainNames.map((domainName) =>
      Option.fromUndefinedOr(remembered.get(domainName)).pipe(
        Option.map((answer) => rememberedCheck(domainName, answer)),
        Option.orElse(() => Option.fromUndefinedOr(freshChecksByDomain.get(domainName))),
        Option.getOrElse(() =>
          DomainCheck.cases.NotChecked.make({
            domainName,
            failure: DomainCheckFailure.cases.RegistryResponseUnreadable.make({}),
          }),
        ),
      ),
    );
  });

  return AvailabilityChecker.of({ checkDomains });
});

/** Provides the checker while leaving its cache and relay client to the caller. */
export const availabilityCheckerLayerWithoutDependencies = Layer.effect(
  AvailabilityChecker,
  makeAvailabilityChecker,
);

/** Provides the checker over Workers KV and the deployed Registro.br relay. */
export const availabilityCheckerLayer = availabilityCheckerLayerWithoutDependencies.pipe(
  Layer.provide([availabilityCacheLayer, registryRelayClientLayer]),
);

/** Provides the checker over an in-memory cache and a relay with a fixed Registry. */
export const availabilityCheckerTestLayer = availabilityCheckerLayerWithoutDependencies.pipe(
  Layer.provide([availabilityCacheTestLayer, registryRelayClientTestLayer]),
);
