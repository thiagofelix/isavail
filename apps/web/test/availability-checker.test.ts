import { DomainName } from "@isavail/availability-contract";
import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { availabilityCacheTestLayer } from "../src/api/availability-cache.ts";
import {
  AvailabilityChecker,
  availabilityCheckerLayerWithoutDependencies,
  availabilityCheckerTestLayer,
} from "../src/api/availability-checker.ts";
import {
  RegistryRelayClient,
  RegistryRelayUnavailable,
  TEST_RATE_LIMITED_DOMAIN,
} from "../src/api/registry-relay-client.ts";

const checkTags = (domainNames: ReadonlyArray<string>) =>
  AvailabilityChecker.use((checker) =>
    checker.checkDomains(domainNames.map((domainName) => DomainName.make(domainName))),
  ).pipe(
    Effect.map((checks) =>
      checks.map((check) =>
        check._tag === "Checked"
          ? `${check.availability._tag}${check.servedFromCache ? " (cache)" : ""}`
          : check.failure._tag,
      ),
    ),
  );

const unavailableRelayLayer = Layer.succeed(
  RegistryRelayClient,
  RegistryRelayClient.of({
    lookUpDomains: () =>
      Effect.fail(
        new RegistryRelayUnavailable({
          reason: "Unreachable",
          message: "The relay did not answer.",
        }),
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
        Effect.provide([availabilityCheckerTestLayer, RuntimeContext.phantom]),
      ),
  );

  it.effect("reuses a fresh answer instead of asking Registro.br again", () =>
    Effect.gen(function* () {
      const first = yield* checkTags(["gov.com.br"]);
      const second = yield* checkTags(["gov.com.br"]);

      assert.deepStrictEqual([...first, ...second], ["Unavailable", "Unavailable (cache)"]);
    }).pipe(Effect.provide([availabilityCheckerTestLayer, RuntimeContext.phantom])),
  );

  it.effect("asks again once an available domain's answer is no longer fresh", () =>
    Effect.gen(function* () {
      yield* checkTags(["livre.com.br", "registro.br"]);
      yield* TestClock.adjust(Duration.minutes(6));

      const later = yield* checkTags(["livre.com.br", "registro.br"]);

      assert.deepStrictEqual(later, ["Available", "Registered (cache)"]);
    }).pipe(Effect.provide([availabilityCheckerTestLayer, RuntimeContext.phantom])),
  );

  it.effect("reports every unanswered domain as not checked when the relay cannot be reached", () =>
    checkTags(["livre.com.br", "outra.com.br"]).pipe(
      Effect.map((tags) =>
        assert.deepStrictEqual(tags, ["LookupServiceUnavailable", "LookupServiceUnavailable"]),
      ),
      Effect.provide(
        availabilityCheckerLayerWithoutDependencies.pipe(
          Layer.provide([availabilityCacheTestLayer, unavailableRelayLayer]),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    ),
  );
});
