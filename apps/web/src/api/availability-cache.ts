import { DomainAvailability, type DomainName } from "@isavail/availability-contract";
import { type RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Array, Context, DateTime, Duration, Effect, Layer, Option, Ref, Schema } from "effect";

/** Remembered answers about domains, so repeated checks do not spend Registro.br's query budget. */
export const AvailabilityCacheNamespace = Cloudflare.KV.Namespace("AvailabilityCache");

/** A Registro.br answer about one domain and when Registro.br gave it. */
export const RememberedAvailability = Schema.Struct({
  availability: DomainAvailability,
  checkedAt: Schema.DateTimeUtcFromString,
});

/** A Registro.br answer about one domain and when Registro.br gave it. */
export type RememberedAvailability = typeof RememberedAvailability.Type;

/**
 * Keeps recent Registro.br answers for reuse. Its operations read and write
 * Workers KV, so they run inside a Worker invocation (`RuntimeContext`).
 */
export interface IAvailabilityCache {
  /**
   * Reads the remembered answers that are still fresh.
   *
   * @returns The fresh answers by domain. Domains without one are absent. A
   * cache that cannot be read behaves as an empty cache.
   */
  readonly readAvailabilities: (
    domainNames: ReadonlyArray<DomainName>,
  ) => Effect.Effect<ReadonlyMap<DomainName, RememberedAvailability>, never, RuntimeContext>;
  /**
   * Remembers answers for as long as each kind of answer stays trustworthy.
   * An answer that cannot be stored is dropped; the next check asks Registro.br.
   */
  readonly rememberAvailabilities: (
    answers: ReadonlyArray<readonly [DomainName, RememberedAvailability]>,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

/**
 * Provides the contextual availability cache.
 *
 * @effect-expect-leaking RuntimeContext Each call reads the Worker invocation it runs in.
 */
export class AvailabilityCache extends Context.Service<AvailabilityCache, IAvailabilityCache>()(
  "@isavail/web/api/availability-cache/AvailabilityCache",
) {}

/**
 * How long an answer stays trustworthy. An available domain can be taken at
 * any moment, so it is remembered briefly; a reservation or an invalid name
 * rarely changes.
 */
export const availabilityLifetime = (availability: DomainAvailability): Duration.Duration =>
  DomainAvailability.match(availability, {
    Available: () => Duration.minutes(5),
    AvailableWithCompetingTickets: () => Duration.minutes(5),
    Registered: () => Duration.hours(6),
    Unavailable: () => Duration.hours(24),
    AwaitingRelease: () => Duration.minutes(30),
    ReleaseInProgress: () => Duration.minutes(15),
    CompetitiveReleaseInProgress: () => Duration.minutes(15),
  });

/** Workers KV refuses expirations shorter than one minute. */
const MIN_KV_EXPIRATION_SECONDS = 60;

const cacheKey = (domainName: DomainName): string => `availability:v1:${domainName}`;

const RememberedAvailabilityFromJson = Schema.fromJsonString(RememberedAvailability);
const decodeRememberedAvailability = Schema.decodeEffect(RememberedAvailabilityFromJson);
const encodeRememberedAvailability = Schema.encodeEffect(RememberedAvailabilityFromJson);

/** Constructs the cache over the Worker's KV namespace binding. */
export const makeAvailabilityCache = Effect.gen(function* () {
  const namespace = yield* Cloudflare.KV.ReadWriteNamespace(AvailabilityCacheNamespace);

  const readAvailabilities = Effect.fn("AvailabilityCache.readAvailabilities")(
    function* (domainNames: ReadonlyArray<DomainName>) {
      const values = yield* namespace.get(Array.map(domainNames, cacheKey), "text");
      const remembered = new Map<DomainName, RememberedAvailability>();

      for (const domainName of domainNames) {
        const maybeValue = Option.fromNullishOr(values.get(cacheKey(domainName)));

        if (Option.isNone(maybeValue)) {
          continue;
        }

        const decoded = yield* decodeRememberedAvailability(maybeValue.value).pipe(Effect.option);

        if (Option.isSome(decoded)) {
          remembered.set(domainName, decoded.value);
        }
      }

      return remembered;
    },
    Effect.catchTag("NamespaceError", (error) =>
      Effect.logWarning("Could not read remembered availabilities", error.message).pipe(
        Effect.as(new Map<DomainName, RememberedAvailability>()),
      ),
    ),
  );

  const rememberAvailability = (domainName: DomainName, answer: RememberedAvailability) =>
    Effect.gen(function* () {
      const value = yield* encodeRememberedAvailability(answer);
      const expirationTtl = Math.max(
        MIN_KV_EXPIRATION_SECONDS,
        Math.round(Duration.toSeconds(availabilityLifetime(answer.availability))),
      );

      yield* namespace.put(cacheKey(domainName), value, { expirationTtl });
    }).pipe(
      Effect.catchTags({
        NamespaceError: (error) =>
          Effect.logWarning("Could not remember an availability", domainName, error.message),
        SchemaError: (error) =>
          Effect.logWarning(
            "Could not encode an availability to remember",
            domainName,
            error.message,
          ),
      }),
    );

  const rememberAvailabilities = Effect.fn("AvailabilityCache.rememberAvailabilities")(function* (
    answers: ReadonlyArray<readonly [DomainName, RememberedAvailability]>,
  ) {
    yield* Effect.forEach(
      answers,
      ([domainName, answer]) => rememberAvailability(domainName, answer),
      { concurrency: "unbounded", discard: true },
    );
  });

  return AvailabilityCache.of({ readAvailabilities, rememberAvailabilities });
});

/** Provides the cache over the KV namespace binding the caller's Worker provides. */
export const availabilityCacheLayerWithoutDependencies = Layer.effect(
  AvailabilityCache,
  makeAvailabilityCache,
);

/** Provides the cache over a native Workers KV binding. */
export const availabilityCacheLayer = availabilityCacheLayerWithoutDependencies.pipe(
  Layer.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
);

/**
 * Provides an in-memory cache that forgets each answer when its lifetime
 * ends, as Workers KV expiration does.
 */
export const availabilityCacheTestLayer = Layer.effect(
  AvailabilityCache,
  Effect.gen(function* () {
    const entries = yield* Ref.make(
      new Map<
        DomainName,
        { readonly answer: RememberedAvailability; readonly expiresAt: DateTime.Utc }
      >(),
    );

    return AvailabilityCache.of({
      readAvailabilities: (domainNames) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const current = yield* Ref.get(entries);
          const remembered = new Map<DomainName, RememberedAvailability>();

          for (const domainName of domainNames) {
            const entry = current.get(domainName);

            if (entry !== undefined && DateTime.isGreaterThan(entry.expiresAt, now)) {
              remembered.set(domainName, entry.answer);
            }
          }

          return remembered;
        }),
      rememberAvailabilities: (answers) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;

          yield* Ref.update(entries, (current) => {
            const next = new Map(current);

            for (const [domainName, answer] of answers) {
              next.set(domainName, {
                answer,
                expiresAt: DateTime.addDuration(now, availabilityLifetime(answer.availability)),
              });
            }

            return next;
          });
        }),
    });
  }),
);
