import { NodeDatagramSocket } from "@effect/platform-node";
import { DomainName, type RegistryLookup } from "@isavail/availability-contract";
import { assert, describe, it } from "@effect/vitest";
import { Array, Duration, Effect, Layer, Option, pipe, Ref } from "effect";
import { RateLimiter } from "effect/persistence";
import {
  IsavailClient,
  IsavailClientSettings,
  isavailClientLayerWithoutDependencies,
} from "../src/isavail-client.ts";

const ISSUED_COOKIE = "0123456789abcdef0123";

interface ReceivedQuery {
  readonly cookie: string;
  readonly queryId: string;
  readonly domainName: string;
}

const decodeLatin1 = (payload: Uint8Array): string =>
  pipe(
    Array.fromIterable(payload),
    Array.map((byte) => String.fromCharCode(byte)),
    Array.join(""),
  );

const encodeLatin1 = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

/**
 * A UDP server that follows the ISAVAIL protocol the way Registro.br does: it
 * issues a cookie to a client that has none, then answers with whatever
 * `answer` returns, or stays silent when `answer` returns none.
 */
const startFakeRegistry = (answer: (query: ReceivedQuery) => Option.Option<string>) =>
  Effect.gen(function* () {
    const socket = yield* NodeDatagramSocket.make({ bind: { address: "127.0.0.1", port: 0 } });
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const receivedQueries = yield* Ref.make<ReadonlyArray<ReceivedQuery>>([]);

    const serve = Effect.gen(function* () {
      for (const datagram of yield* reader.pull) {
        const [, cookie = "", , queryId = "", domainName = ""] = decodeLatin1(
          datagram.payload,
        ).split(" ");
        const query = { cookie, queryId, domainName };

        yield* Ref.update(receivedQueries, (queries) => [...queries, query]);

        const maybeReply =
          cookie === ISSUED_COOKIE ? answer(query) : Option.some(`CK ${ISSUED_COOKIE} ${queryId}`);

        if (Option.isSome(maybeReply)) {
          yield* writer.write({ payload: encodeLatin1(maybeReply.value), address: datagram });
        }
      }
    });

    yield* Effect.forkScoped(Effect.forever(serve));

    return { port: reader.address.port, receivedQueries };
  });

const clientLayerFor = (registryPort: number, settings: Partial<IsavailClientSettings> = {}) =>
  isavailClientLayerWithoutDependencies.pipe(
    Layer.provide(RateLimiter.layer),
    Layer.provide(RateLimiter.layerStoreMemory),
    Layer.provide(
      Layer.succeed(IsavailClientSettings, {
        registryHost: "127.0.0.1",
        registryPort,
        answerTimeout: Duration.millis(100),
        maxAttempts: 3,
        maxQueriesInFlight: 1,
        queryBurstLimit: 100,
        queryBurstWindow: Duration.seconds(1),
        maxPacingDelay: Duration.seconds(1),
        rateLimitBackoff: Duration.seconds(30),
        ...settings,
      }),
    ),
  );

const availabilityTags = (lookups: ReadonlyArray<RegistryLookup>) =>
  Array.map(lookups, (lookup) =>
    lookup._tag === "Resolved" ? lookup.availability._tag : lookup.failure._tag,
  );

const answerByDomain = (query: ReceivedQuery): Option.Option<string> => {
  if (query.domainName === "registrada.com.br") {
    return Option.some(
      `% Copyright Nic.br\r\nST 2 ${query.queryId}\r\nregistrada.com.br\r\n2030-01-01|published|ns1.exemplo.com.br\r\n\r\n`,
    );
  } else if (query.domainName === "silenciosa.com.br") {
    return Option.none();
  } else if (query.domainName === "limitada.com.br") {
    return Option.some("% Copyright Nic.br\r\nST 8\r\nQuery rate limit exceeded\r\n");
  } else {
    return Option.some(`% Copyright Nic.br\r\nST 0 ${query.queryId}\r\n${query.domainName}\r\n`);
  }
};

describe("IsavailClient", () => {
  it.live("renews its cookie once, then reuses it for every later query", () =>
    Effect.gen(function* () {
      const registry = yield* startFakeRegistry(answerByDomain);

      const lookups = yield* Effect.gen(function* () {
        const client = yield* IsavailClient;
        const first = yield* client.lookUpDomains([DomainName.make("livre.com.br")]);
        const second = yield* client.lookUpDomains([DomainName.make("registrada.com.br")]);

        return [...first, ...second];
      }).pipe(Effect.provide(clientLayerFor(registry.port)));

      const queries = yield* Ref.get(registry.receivedQueries);

      assert.deepStrictEqual(availabilityTags(lookups), ["Available", "Registered"]);
      assert.deepStrictEqual(
        Array.map(queries, ({ cookie, domainName }) => [cookie === ISSUED_COOKIE, domainName]),
        [
          [false, "livre.com.br"],
          [true, "livre.com.br"],
          [true, "registrada.com.br"],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.live("answers a batch in request order while queries run concurrently", () =>
    Effect.gen(function* () {
      const registry = yield* startFakeRegistry(answerByDomain);
      const domainNames = Array.map(
        ["um.com.br", "registrada.com.br", "dois.com.br", "tres.com.br"],
        (domainName) => DomainName.make(domainName),
      );

      const lookups = yield* IsavailClient.use((client) => client.lookUpDomains(domainNames)).pipe(
        Effect.provide(clientLayerFor(registry.port)),
      );

      assert.deepStrictEqual(
        Array.map(lookups, ({ domainName }) => domainName),
        domainNames,
      );
      assert.deepStrictEqual(availabilityTags(lookups), [
        "Available",
        "Registered",
        "Available",
        "Available",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("never attributes an answer about another domain to the query that received it", () =>
    Effect.gen(function* () {
      const registry = yield* startFakeRegistry((query) =>
        query.domainName === "trocada.com.br"
          ? Option.some(
              `% Copyright Nic.br\r\nST 2 ${query.queryId}\r\noutra.com.br\r\n2030-01-01|published|ns1.outra.com.br\r\n\r\n`,
            )
          : answerByDomain(query),
      );

      const lookups = yield* IsavailClient.use((client) =>
        client.lookUpDomains([DomainName.make("trocada.com.br")]),
      ).pipe(Effect.provide(clientLayerFor(registry.port)));

      assert.deepStrictEqual(availabilityTags(lookups), ["RegistryUnreachable"]);
    }).pipe(Effect.scoped),
  );

  it.live("reports a domain unreachable after every attempt goes unanswered", () =>
    Effect.gen(function* () {
      const registry = yield* startFakeRegistry(answerByDomain);

      const lookups = yield* IsavailClient.use((client) =>
        client.lookUpDomains([DomainName.make("silenciosa.com.br")]),
      ).pipe(Effect.provide(clientLayerFor(registry.port)));

      const queries = yield* Ref.get(registry.receivedQueries);

      assert.deepStrictEqual(availabilityTags(lookups), ["RegistryUnreachable"]);
      assert.strictEqual(Array.filter(queries, ({ cookie }) => cookie === ISSUED_COOKIE).length, 2);
    }).pipe(Effect.scoped),
  );

  it.live("stops asking Registro.br while it limits the query rate", () =>
    Effect.gen(function* () {
      const registry = yield* startFakeRegistry(answerByDomain);

      const { limited, afterLimit } = yield* Effect.gen(function* () {
        const client = yield* IsavailClient;
        const limited = yield* client.lookUpDomains([DomainName.make("limitada.com.br")]);
        const afterLimit = yield* client.lookUpDomains([DomainName.make("livre.com.br")]);

        return { limited, afterLimit };
      }).pipe(Effect.provide(clientLayerFor(registry.port)));

      const queries = yield* Ref.get(registry.receivedQueries);
      const [limitedLookup] = limited;

      assert.deepStrictEqual(availabilityTags(afterLimit), ["RegistryRateLimited"]);
      assert.isTrue(
        limitedLookup?._tag === "Failed" &&
          limitedLookup.failure._tag === "RegistryRateLimited" &&
          limitedLookup.failure.retryAfterSeconds === 30,
      );
      assert.isFalse(Array.some(queries, ({ domainName }) => domainName === "livre.com.br"));
    }).pipe(Effect.scoped),
  );
});

describe("IsavailClient pacing", () => {
  it.live("reports a domain rate limited instead of waiting past the pacing deadline", () =>
    Effect.gen(function* () {
      const registry = yield* startFakeRegistry(answerByDomain);

      const lookups = yield* IsavailClient.use((client) =>
        client.lookUpDomains([DomainName.make("livre.com.br")]),
      ).pipe(
        Effect.provide(
          clientLayerFor(registry.port, {
            queryBurstLimit: 1,
            queryBurstWindow: Duration.seconds(10),
            maxPacingDelay: Duration.millis(100),
          }),
        ),
      );

      const queries = yield* Ref.get(registry.receivedQueries);
      const [lookup] = lookups;

      assert.strictEqual(queries.length, 1);
      assert.isTrue(
        lookup?._tag === "Failed" &&
          lookup.failure._tag === "RegistryRateLimited" &&
          lookup.failure.retryAfterSeconds === 10,
      );
    }).pipe(Effect.scoped),
  );
});
