import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { Array, Config, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { DomainAvailability } from "../domain/domain-availability.ts";
import { DomainName } from "../domain/domain-name.ts";

/** A Registro.br answer about one domain and when Registro.br gave it. */
export const RememberedAvailability = Schema.Struct({
  availability: DomainAvailability,
  checkedAt: Schema.DateTimeUtcFromString,
});

/** A Registro.br answer about one domain and when Registro.br gave it. */
export type RememberedAvailability = typeof RememberedAvailability.Type;

/** Keeps recent Registro.br answers for reuse, so repeated checks do not spend its query budget. */
export interface IAvailabilityCache {
  /**
   * Reads the remembered answers that are still fresh.
   *
   * @returns The fresh answers by domain. Domains without one are absent. A
   * cache that cannot be read behaves as an empty cache.
   */
  readonly readAvailabilities: (
    domainNames: ReadonlyArray<DomainName>,
  ) => Effect.Effect<ReadonlyMap<DomainName, RememberedAvailability>>;
  /**
   * Remembers answers for as long as each kind of answer stays trustworthy,
   * and forgets answers that are no longer fresh. An answer that cannot be
   * stored is dropped; the next check asks Registro.br.
   */
  readonly rememberAvailabilities: (
    answers: ReadonlyArray<readonly [DomainName, RememberedAvailability]>,
  ) => Effect.Effect<void>;
}

/** Provides the contextual availability cache. */
export class AvailabilityCache extends Context.Service<AvailabilityCache, IAvailabilityCache>()(
  "@isavail/isavail/api/availability-cache/AvailabilityCache",
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

const RememberedAvailabilityFromJson = Schema.fromJsonString(RememberedAvailability);
const encodeRememberedAvailability = Schema.encodeEffect(RememberedAvailabilityFromJson);

/** One `availability_cache` row as SQLite returns it. */
const CachedAvailabilityRow = Schema.Struct({
  domain_name: DomainName,
  answer: RememberedAvailabilityFromJson,
});
const decodeCachedAvailabilityRow = Schema.decodeUnknownEffect(CachedAvailabilityRow);

/**
 * Creates the `availability_cache` table. `answer` holds a
 * {@link RememberedAvailability} as JSON; `expires_at` is Unix epoch
 * milliseconds after which the answer is no longer fresh.
 */
const availabilityCacheMigrations = SqliteMigrator.layer({
  table: "availability_cache_migrations",
  loader: SqliteMigrator.fromRecord({
    "1_create_availability_cache": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE availability_cache (
          domain_name TEXT PRIMARY KEY NOT NULL,
          answer TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT
      `;
      yield* sql`CREATE INDEX availability_cache_expires_at ON availability_cache (expires_at)`;
    }),
  }),
});

/**
 * Constructs the cache over the contextual SQL client, whose schema the migrations created.
 *
 * @internal
 */
export const makeAvailabilityCache = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readAvailabilities = Effect.fn("AvailabilityCache.readAvailabilities")(
    function* (domainNames: ReadonlyArray<DomainName>) {
      const remembered = new Map<DomainName, RememberedAvailability>();

      if (domainNames.length === 0) {
        return remembered;
      }

      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const rows = yield* sql`
        SELECT domain_name, answer FROM availability_cache
        WHERE ${sql.in("domain_name", domainNames)} AND expires_at > ${now}
      `;

      for (const row of rows) {
        yield* decodeCachedAvailabilityRow(row).pipe(
          Effect.flatMap(({ domain_name, answer }) =>
            Effect.sync(() => remembered.set(domain_name, answer)),
          ),
          Effect.catchTag("SchemaError", (error) =>
            Effect.logWarning("Ignored an unreadable remembered availability", error.message),
          ),
        );
      }

      return remembered;
    },
    Effect.catchTag("SqlError", (error) =>
      Effect.logWarning("Could not read remembered availabilities", error.message).pipe(
        Effect.as(new Map<DomainName, RememberedAvailability>()),
      ),
    ),
  );

  const cachedRow = (domainName: DomainName, answer: RememberedAvailability, now: DateTime.Utc) =>
    encodeRememberedAvailability(answer).pipe(
      Effect.map((encoded) =>
        Option.some({
          domain_name: domainName,
          answer: encoded,
          expires_at: DateTime.toEpochMillis(
            DateTime.addDuration(now, availabilityLifetime(answer.availability)),
          ),
        }),
      ),
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning(
          "Could not encode an availability to remember",
          domainName,
          error.message,
        ).pipe(Effect.as(Option.none())),
      ),
    );

  const rememberAvailabilities = Effect.fn("AvailabilityCache.rememberAvailabilities")(
    function* (answers: ReadonlyArray<readonly [DomainName, RememberedAvailability]>) {
      const now = yield* DateTime.now;
      const rows = Array.getSomes(
        yield* Effect.forEach(answers, ([domainName, answer]) =>
          cachedRow(domainName, answer, now),
        ),
      );

      yield* sql`DELETE FROM availability_cache WHERE expires_at <= ${DateTime.toEpochMillis(now)}`;

      if (rows.length === 0) {
        return;
      }

      yield* sql`
        INSERT INTO availability_cache ${sql.insert(rows)}
        ON CONFLICT (domain_name) DO UPDATE SET
          answer = excluded.answer,
          expires_at = excluded.expires_at
      `;
    },
    Effect.catchTag("SqlError", (error) =>
      Effect.logWarning("Could not remember availabilities", error.message),
    ),
  );

  return AvailabilityCache.of({ readAvailabilities, rememberAvailabilities });
});

/**
 * Provides the cache over the contextual SQL client, creating its table on
 * first use. The caller provides `SqlClient`.
 *
 * @internal
 */
export const availabilityCacheLayerWithoutDependencies = Layer.effect(
  AvailabilityCache,
  makeAvailabilityCache,
).pipe(Layer.provide(availabilityCacheMigrations));

/**
 * Environment variable naming the SQLite file the cache lives in. The file and
 * its table are created on first start; the directory must already exist.
 */
export const DATABASE_PATH_VARIABLE = "ISAVAIL_DATABASE";

/** SQLite file used when {@link DATABASE_PATH_VARIABLE} is not set, relative to the working directory. */
const DEFAULT_DATABASE_PATH = "isavail.sqlite";

/**
 * Provides the cache over the SQLite file named by {@link DATABASE_PATH_VARIABLE}.
 * Building it fails when the file cannot be opened or its table cannot be created.
 *
 * @internal
 */
export const availabilityCacheLayer = availabilityCacheLayerWithoutDependencies.pipe(
  Layer.provide(
    SqliteClient.layerConfig({
      filename: Config.String(DATABASE_PATH_VARIABLE).pipe(
        Config.withDefault(DEFAULT_DATABASE_PATH),
      ),
    }),
  ),
);

/**
 * Provides the cache over a fresh in-memory SQLite database, so tests exercise
 * the same SQL as the service without touching a file.
 */
export const availabilityCacheTestLayer = availabilityCacheLayerWithoutDependencies.pipe(
  Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
  Layer.orDie,
);
