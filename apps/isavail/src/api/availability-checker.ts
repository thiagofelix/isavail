import { Array, Context, Effect, Layer, Option } from "effect";
import type { DomainName } from "../domain/domain-name.ts";
import {
  IsavailClient,
  isavailClientLayer,
  isavailClientTestLayer,
} from "../registry/isavail-client.ts";
import type { RegistryLookup } from "../registry/registry-lookup.ts";
import {
  AvailabilityCache,
  availabilityCacheLayer,
  availabilityCacheTestLayer,
  type RememberedAvailability,
} from "./availability-cache.ts";
import { DomainCheck, DomainCheckFailure } from "./availability-http-api.ts";

/** Checks whether `.br` domains can be registered. */
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
  ) => Effect.Effect<ReadonlyArray<DomainCheck>>;
}

/** Provides the contextual availability checker. */
export class AvailabilityChecker extends Context.Service<
  AvailabilityChecker,
  IAvailabilityChecker
>()("@isavail/isavail/api/availability-checker/AvailabilityChecker") {}

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

/** Constructs the checker over the contextual cache and ISAVAIL client. */
export const makeAvailabilityChecker = Effect.gen(function* () {
  const cache = yield* AvailabilityCache;
  const registry = yield* IsavailClient;

  const checkDomains = Effect.fn("AvailabilityChecker.checkDomains")(function* (
    domainNames: ReadonlyArray<DomainName>,
  ) {
    const remembered = yield* cache.readAvailabilities(domainNames);
    const unknownDomainNames = Array.filter(
      domainNames,
      (domainName) => !remembered.has(domainName),
    );
    const freshChecks =
      unknownDomainNames.length === 0
        ? []
        : Array.map(yield* registry.lookUpDomains(unknownDomainNames), lookupCheck);
    const freshChecksByDomain = new Map(
      Array.map(freshChecks, (check) => [check.domainName, check]),
    );

    yield* cache.rememberAvailabilities(Array.flatMap(freshChecks, rememberedAnswerOf));

    yield* Effect.annotateCurrentSpan({
      "availability.domain_count": domainNames.length,
      "availability.cached_count": remembered.size,
    });

    return Array.map(domainNames, (domainName) =>
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

/** Provides the checker while leaving its cache and ISAVAIL client to the caller. */
export const availabilityCheckerLayerWithoutDependencies = Layer.effect(
  AvailabilityChecker,
  makeAvailabilityChecker,
);

/**
 * Provides the checker over the SQLite cache and Registro.br.
 *
 * @internal
 */
export const availabilityCheckerLayer = availabilityCheckerLayerWithoutDependencies.pipe(
  Layer.provide([availabilityCacheLayer, isavailClientLayer]),
);

/** Provides the checker over an in-memory SQLite cache and an ISAVAIL client with a fixed Registry. */
export const availabilityCheckerTestLayer = availabilityCheckerLayerWithoutDependencies.pipe(
  Layer.provide([availabilityCacheTestLayer, isavailClientTestLayer]),
);
