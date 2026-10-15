import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { availabilityCacheTestLayer } from "../src/api/availability-cache.ts";
import {
  AvailabilityChecker,
  availabilityCheckerLayerWithoutDependencies,
  availabilityCheckerTestLayer,
} from "../src/api/availability-checker.ts";
import { DomainName } from "../src/domain/domain-name.ts";
import { IsavailClient, TEST_RATE_LIMITED_DOMAIN } from "../src/registry/isavail-client.ts";
import { RegistryLookup, RegistryLookupFailure } from "../src/registry/registry-lookup.ts";

const checkTags = (domainNames: ReadonlyArray<string>) =>
  AvailabilityChecker.use((checker) =>
    checker.checkDomains(Array.map(domainNames, (domainName) => DomainName.make(domainName))),
  ).pipe(
    Effect.map((checks) =>
      Array.map(checks, (check) =>
        check._tag === "Checked"
          ? `${check.availability._tag}${check.servedFromCache ? " (cache)" : ""}`
          : check.failure._tag,
      ),
    ),
  );

const unreachableRegistryLayer = Layer.succeed(
  IsavailClient,
  IsavailClient.of({
    lookUpDomains: (domainNames) =>
      Effect.succeed(
        Array.map(domainNames, (domainName) =>
          RegistryLookup.cases.Failed.make({
            domainName,
            failure: RegistryLookupFailure.cases.RegistryUnreachable.make({}),
          }),
        ),
      ),
  }),
);

describe("AvailabilityChecker", () => {
  it.effect(
    "answers in request order and passes rate-limited domains through for a later retry",
    () =>
      checkTags(["registro.br", TEST_RATE_LIMITED_DOMAIN, "livre.com.br"]).pipe(
        Effect.map((tags) =>
          assert.deepStrictEqual(tags, ["Registered", "RegistryRateLimited", "Available"]),
        ),
        Effect.provide(availabilityCheckerTestLayer),
      ),
  );

  it.effect("reuses a fresh answer instead of asking Registro.br again", () =>
    Effect.gen(function* () {
      const first = yield* checkTags(["gov.com.br"]);
      const second = yield* checkTags(["gov.com.br"]);

      assert.deepStrictEqual([...first, ...second], ["Unavailable", "Unavailable (cache)"]);
    }).pipe(Effect.provide(availabilityCheckerTestLayer)),
  );

  it.effect("asks again once an available domain's answer is no longer fresh", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-15T13:00:00Z")));
      yield* checkTags(["livre.com.br", "registro.br"]);
      yield* TestClock.adjust(Duration.minutes(6));

      const later = yield* checkTags(["livre.com.br", "registro.br"]);

      assert.deepStrictEqual(later, ["Available", "Registered (cache)"]);
    }).pipe(Effect.provide(availabilityCheckerTestLayer)),
  );

  it.effect("never remembers a domain Registro.br did not answer for", () =>
    Effect.gen(function* () {
      const first = yield* checkTags(["livre.com.br"]);
      const second = yield* checkTags(["livre.com.br"]);

      assert.deepStrictEqual([...first, ...second], ["RegistryUnreachable", "RegistryUnreachable"]);
    }).pipe(
      Effect.provide(
        availabilityCheckerLayerWithoutDependencies.pipe(
          Layer.provide([availabilityCacheTestLayer, unreachableRegistryLayer]),
        ),
      ),
    ),
  );
});
