import { NodeDatagramSocket } from "@effect/platform-node";
import {
  DomainAvailability,
  type DomainName,
  RegistrationExpiry,
  RegistryLookup,
  RegistryLookupFailure,
  RetryAfterSeconds,
} from "@isavail/availability-contract";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Random,
  Ref,
  Semaphore,
} from "effect";
import { RateLimiter } from "effect/persistence";
import type { DatagramSocket } from "effect/socket";
import {
  decodeIsavailResponse,
  encodeIsavailQuery,
  type IsavailCookie,
  IsavailQueryId,
  IsavailResponse,
  isRateLimitRefusal,
  MAX_ISAVAIL_QUERY_ID,
  MIN_ISAVAIL_QUERY_ID,
  UNISSUED_ISAVAIL_COOKIE,
} from "./isavail-protocol.ts";

/**
 * Rate-limit key for every query this process sends. Registro.br limits
 * queries per source address, and a relay process has one source address.
 */
const REGISTRY_RATE_LIMIT_KEY = "registro.br/isavail";

/**
 * Status the adaptive rate limiter understands as "too many requests".
 * Registro.br signals the same condition with an `ST 8` rate-limit refusal.
 */
const TOO_MANY_REQUESTS_STATUS = 429;

/** How the relay reaches and paces the Registro.br ISAVAIL service. */
export interface IsavailClientSettings {
  /** Host name or IP address of the ISAVAIL service. */
  readonly registryHost: string;
  /** UDP port of the ISAVAIL service. */
  readonly registryPort: number;
  /** How long one query waits for its answer before it is sent again. */
  readonly answerTimeout: Duration.Duration;
  /** Sends of one query, including the resend after a cookie renewal, before the domain is reported unreachable. */
  readonly maxAttempts: number;
  /**
   * Queries awaiting an answer at once across every request the process
   * serves. Registro.br mixes up concurrent queries from one source address:
   * it answers one query identifier with another query's domain, repeats
   * answers, and drops others. One query at a time is what its own clients do.
   */
  readonly maxQueriesInFlight: number;
  /** Queries the relay may send in a burst; also the capacity of its token bucket. */
  readonly queryBurstLimit: number;
  /** Time the token bucket takes to refill from empty to {@link IsavailClientSettings.queryBurstLimit}. */
  readonly queryBurstWindow: Duration.Duration;
  /**
   * Longest one lookup request may spend waiting for query budget. Domains
   * whose turn would come later are reported rate limited, so a large batch
   * answers what fits in the budget instead of holding its caller for the
   * whole refill.
   */
  readonly maxPacingDelay: Duration.Duration;
  /**
   * How long the relay stops asking after Registro.br refuses for rate.
   * Registro.br does not say how long to wait, so this stands in for a
   * `Retry-After` value.
   */
  readonly rateLimitBackoff: Duration.Duration;
}

/**
 * Production settings.
 *
 * Measured on 2026-10-15, Registro.br limits each source address with a token
 * bucket of 30 queries that refills at one query per second, and refuses every
 * query once it is empty. The relay keeps a margin below both numbers: a burst
 * of 25, refilled at one query every 1.2 seconds.
 */
export const IsavailClientSettings = Context.Reference<IsavailClientSettings>(
  "@isavail/relay/IsavailClientSettings",
  {
    defaultValue: () => ({
      registryHost: "avail.registro.br",
      registryPort: 43,
      answerTimeout: Duration.seconds(2),
      maxAttempts: 3,
      maxQueriesInFlight: 1,
      queryBurstLimit: 25,
      queryBurstWindow: Duration.seconds(30),
      maxPacingDelay: Duration.seconds(5),
      rateLimitBackoff: Duration.seconds(5),
    }),
  },
);

/** Defines the Registro.br availability lookups the relay performs. */
export interface IIsavailClient {
  /**
   * Asks Registro.br about each domain.
   *
   * @returns One lookup per domain, in the order given. A domain Registro.br
   * could not answer for is a `Failed` lookup; the effect itself never fails.
   */
  readonly lookUpDomains: (
    domainNames: ReadonlyArray<DomainName>,
  ) => Effect.Effect<ReadonlyArray<RegistryLookup>>;
}

/** Provides the contextual Registro.br ISAVAIL client. */
export class IsavailClient extends Context.Service<IsavailClient, IIsavailClient>()(
  "@isavail/relay/IsavailClient",
) {}

type QueryOutcome =
  | { readonly _tag: "CookieRenewed" }
  | { readonly _tag: "Answered"; readonly availability: DomainAvailability }
  | { readonly _tag: "Refused"; readonly registryMessage: string };

type AttemptResult =
  | { readonly _tag: "Throttled"; readonly retryAfter: Duration.Duration }
  | { readonly _tag: "Unanswered" }
  | { readonly _tag: "Responded"; readonly outcome: QueryOutcome; readonly epoch: number };

type QueryReservation =
  | { readonly _tag: "Reserved"; readonly epoch: number }
  | { readonly _tag: "Throttled"; readonly retryAfter: Duration.Duration };

interface PendingQuery {
  readonly domainName: DomainName;
  readonly answer: Deferred.Deferred<QueryOutcome>;
}

type PendingQueries = Map<IsavailQueryId, PendingQuery>;

const reserved = (epoch: number): QueryReservation => ({ _tag: "Reserved", epoch });

const throttled = (retryAfter: Duration.Duration): QueryReservation => ({
  _tag: "Throttled",
  retryAfter,
});

const failedLookup = (domainName: DomainName, failure: RegistryLookupFailure): RegistryLookup =>
  RegistryLookup.cases.Failed.make({ domainName, failure });

const rateLimitedFailure = (retryAfter: Duration.Duration): RegistryLookupFailure =>
  RegistryLookupFailure.cases.RegistryRateLimited.make({
    retryAfterSeconds: RetryAfterSeconds.make(
      Math.max(1, Math.ceil(Duration.toSeconds(retryAfter))),
    ),
  });

/**
 * Constructs the ISAVAIL client.
 *
 * The client keeps the Registry cookie for the life of the process, because
 * Registro.br issues it per source address, and paces every send through the
 * contextual `RateLimiter`. Each lookup batch opens its own UDP socket and
 * correlates answers by query identifier, so concurrent batches never read
 * each other's answers.
 */
export const makeIsavailClient = Effect.gen(function* () {
  const settings = yield* IsavailClientSettings;
  const limiter = yield* RateLimiter.RateLimiter;
  const currentCookie = yield* Ref.make<IsavailCookie>(UNISSUED_ISAVAIL_COOKIE);
  const queriesInFlight = yield* Semaphore.make(settings.maxQueriesInFlight);

  const fitsBefore = (deadline: DateTime.Utc, wait: Duration.Duration) =>
    DateTime.now.pipe(
      Effect.map((now) => !DateTime.isGreaterThan(DateTime.addDuration(now, wait), deadline)),
    );

  /**
   * Takes one token from the bucket that mirrors Registro.br's limit. A token
   * that becomes available before the request's pacing deadline is waited
   * for; a later one is reported instead, because an HTTP caller is waiting on
   * the answer. The bucket never goes into debt for a query that is not sent.
   */
  const takeQueryToken = (
    epoch: number,
    deadline: DateTime.Utc,
  ): Effect.Effect<QueryReservation, RateLimiter.RateLimiterError> =>
    limiter
      .consume({
        key: REGISTRY_RATE_LIMIT_KEY,
        algorithm: "token-bucket",
        onExceeded: "fail",
        limit: settings.queryBurstLimit,
        window: settings.queryBurstWindow,
      })
      .pipe(
        Effect.as(reserved(epoch)),
        Effect.catchReason("RateLimiterError", "RateLimitExceeded", ({ retryAfter }) =>
          fitsBefore(deadline, retryAfter).pipe(
            Effect.flatMap((fits) =>
              fits
                ? Effect.sleep(retryAfter).pipe(Effect.andThen(takeQueryToken(epoch, deadline)))
                : Effect.succeed(throttled(retryAfter)),
            ),
          ),
        ),
      );

  /**
   * Reserves the right to send one query, the way `HttpClient.withRateLimiter`
   * does: the adaptive state holds every send back while a Registro.br refusal
   * cooldown lasts and paces sends at a rate it learned from refusals, and the
   * token bucket keeps sends under the measured limit.
   */
  const reserveQuery = (deadline: DateTime.Utc): Effect.Effect<QueryReservation> =>
    Effect.gen(function* () {
      const adaptive = yield* limiter.adaptiveConsume({
        key: REGISTRY_RATE_LIMIT_KEY,
        tokens: 1,
        fallbackLimit: settings.queryBurstLimit,
        fallbackWindow: settings.queryBurstWindow,
      });

      if (
        (adaptive.phase === "cooldown" && !Duration.isZero(adaptive.delay)) ||
        !(yield* fitsBefore(deadline, adaptive.delay))
      ) {
        return throttled(adaptive.delay);
      }

      yield* Effect.sleep(adaptive.delay);

      return yield* takeQueryToken(adaptive.epoch, deadline);
    }).pipe(
      Effect.catchTag("RateLimiterError", (error) =>
        Effect.logWarning("Could not reserve an ISAVAIL query budget", error.message).pipe(
          Effect.as(throttled(settings.rateLimitBackoff)),
        ),
      ),
    );

  const reportRateLimitRefusal = (epoch: number) =>
    limiter
      .adaptiveFeedback({
        key: REGISTRY_RATE_LIMIT_KEY,
        epoch,
        tokens: 1,
        status: TOO_MANY_REQUESTS_STATUS,
        retryAfter: settings.rateLimitBackoff,
      })
      .pipe(
        Effect.catchTag("RateLimiterError", (error) =>
          Effect.logWarning("Could not record a Registro.br rate-limit refusal", error.message),
        ),
      );

  const settle = (pending: PendingQueries, queryId: IsavailQueryId, outcome: QueryOutcome) =>
    Option.fromUndefinedOr(pending.get(queryId)).pipe(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ answer }) => Deferred.succeed(answer, outcome),
      }),
    );

  const settleAll = (pending: PendingQueries, outcome: QueryOutcome) =>
    Effect.forEach(pending.values(), ({ answer }) => Deferred.succeed(answer, outcome), {
      discard: true,
    });

  const settleAnswer = (
    pending: PendingQueries,
    queryId: IsavailQueryId,
    echoedDomainName: string,
    availability: DomainAvailability,
  ) =>
    Option.fromUndefinedOr(pending.get(queryId)).pipe(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ domainName, answer }) =>
          domainName === echoedDomainName
            ? Deferred.succeed(answer, { _tag: "Answered", availability })
            : Effect.logWarning(
                "Ignored an ISAVAIL answer about a different domain than its query asked about",
                { queryId, askedAbout: domainName, answeredAbout: echoedDomainName },
              ),
      }),
    );

  const dispatchResponse = (pending: PendingQueries, response: IsavailResponse) =>
    IsavailResponse.match(response, {
      CookieIssued: ({ cookie, queryId }) =>
        Ref.set(currentCookie, cookie).pipe(
          Effect.andThen(settle(pending, queryId, { _tag: "CookieRenewed" })),
        ),
      Answered: ({ queryId, echoedDomainName, availability }) =>
        settleAnswer(pending, queryId, echoedDomainName, availability),
      Refused: ({ queryId, registryMessage }) =>
        // NOTE: Registro.br omits the query identifier from most refusals, so
        // the refusal cannot be tied to one query and settles all of them.
        Option.match(queryId, {
          onNone: () => settleAll(pending, { _tag: "Refused", registryMessage }),
          onSome: (refusedQueryId) =>
            settle(pending, refusedQueryId, { _tag: "Refused", registryMessage }),
        }),
    });

  const receiveResponses = (reader: DatagramSocket.Reader, pending: PendingQueries) =>
    Effect.gen(function* () {
      for (const datagram of yield* reader.pull) {
        yield* decodeIsavailResponse(datagram.payload).pipe(
          Effect.flatMap((response) => dispatchResponse(pending, response)),
          Effect.catchTag("IsavailResponseUnreadable", (error) =>
            Effect.logWarning("Ignored an unreadable ISAVAIL datagram", error.message),
          ),
        );
      }
    }).pipe(
      Effect.forever,
      Effect.catchTag("DatagramSocketError", () => Effect.void),
    );

  const nextQueryId = (pending: PendingQueries): Effect.Effect<IsavailQueryId> =>
    Effect.gen(function* () {
      const candidate = IsavailQueryId.make(
        yield* Random.nextIntBetween(MIN_ISAVAIL_QUERY_ID, MAX_ISAVAIL_QUERY_ID),
      );

      return pending.has(candidate) ? yield* nextQueryId(pending) : candidate;
    });

  const sendAndAwait = (
    writer: DatagramSocket.Writer,
    pending: PendingQueries,
    domainName: DomainName,
  ): Effect.Effect<Option.Option<QueryOutcome>> =>
    Effect.gen(function* () {
      const queryId = yield* nextQueryId(pending);
      const answer = yield* Deferred.make<QueryOutcome>();
      pending.set(queryId, { domainName, answer });

      const cookie = yield* Ref.get(currentCookie);

      return yield* writer
        .write({ payload: encodeIsavailQuery({ cookie, queryId, domainName }) })
        .pipe(
          Effect.andThen(Deferred.await(answer)),
          Effect.timeoutOption(settings.answerTimeout),
          Effect.catchTag("DatagramSocketError", () => Effect.succeedNone),
          Effect.ensuring(Effect.sync(() => pending.delete(queryId))),
        );
    });

  const attempt = (
    writer: DatagramSocket.Writer,
    pending: PendingQueries,
    domainName: DomainName,
    deadline: DateTime.Utc,
  ): Effect.Effect<AttemptResult> =>
    Effect.gen(function* () {
      const reservation = yield* reserveQuery(deadline);

      if (reservation._tag === "Throttled") {
        return reservation;
      }

      const maybeOutcome = yield* sendAndAwait(writer, pending, domainName);

      return Option.match(maybeOutcome, {
        onNone: (): AttemptResult => ({ _tag: "Unanswered" }),
        onSome: (outcome): AttemptResult => ({
          _tag: "Responded",
          outcome,
          epoch: reservation.epoch,
        }),
      });
    }).pipe(
      // NOTE: the budget is reserved inside the in-flight permit so that a
      // refusal seen by the query ahead stops every query queued behind it.
      queriesInFlight.withPermits(1),
    );

  const lookUpDomain = Effect.fnUntraced(function* (
    writer: DatagramSocket.Writer,
    pending: PendingQueries,
    domainName: DomainName,
    deadline: DateTime.Utc,
  ) {
    for (let attemptNumber = 1; attemptNumber <= settings.maxAttempts; attemptNumber++) {
      const result = yield* attempt(writer, pending, domainName, deadline);

      if (result._tag === "Throttled") {
        return failedLookup(domainName, rateLimitedFailure(result.retryAfter));
      } else if (result._tag === "Unanswered") {
        continue;
      }

      const { outcome, epoch } = result;

      if (outcome._tag === "Answered") {
        return RegistryLookup.cases.Resolved.make({
          domainName,
          availability: outcome.availability,
          checkedAt: yield* DateTime.now,
        });
      } else if (outcome._tag === "Refused" && isRateLimitRefusal(outcome.registryMessage)) {
        yield* reportRateLimitRefusal(epoch);

        return failedLookup(domainName, rateLimitedFailure(settings.rateLimitBackoff));
      } else if (outcome._tag === "Refused") {
        return failedLookup(
          domainName,
          RegistryLookupFailure.cases.RegistryFailed.make({
            registryMessage: outcome.registryMessage,
          }),
        );
      }
    }

    return failedLookup(domainName, RegistryLookupFailure.cases.RegistryUnreachable.make({}));
  });

  const lookUpBatch = (domainNames: ReadonlyArray<DomainName>) =>
    Effect.gen(function* () {
      const socket = yield* NodeDatagramSocket.make({
        connect: { address: settings.registryHost, port: settings.registryPort },
      });
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const pending: PendingQueries = new Map();
      const pacingDeadline = DateTime.addDuration(yield* DateTime.now, settings.maxPacingDelay);

      yield* Effect.forkScoped(receiveResponses(reader, pending));

      return yield* Effect.forEach(
        domainNames,
        (domainName) => lookUpDomain(writer, pending, domainName, pacingDeadline),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.scoped);

  const lookUpDomains = Effect.fn("IsavailClient.lookUpDomains")(function* (
    domainNames: ReadonlyArray<DomainName>,
  ) {
    yield* Effect.annotateCurrentSpan("isavail.domain_count", domainNames.length);

    return yield* lookUpBatch(domainNames).pipe(
      Effect.catchTag("DatagramSocketError", (error) =>
        Effect.logWarning("Could not open a UDP socket to Registro.br", error.message).pipe(
          Effect.as(
            domainNames.map((domainName) =>
              failedLookup(domainName, RegistryLookupFailure.cases.RegistryUnreachable.make({})),
            ),
          ),
        ),
      ),
    );
  });

  return IsavailClient.of({ lookUpDomains });
});

/**
 * Provides the ISAVAIL client while leaving its `RateLimiter` to the caller.
 * Settings come from {@link IsavailClientSettings}, whose default is production.
 */
export const isavailClientLayerWithoutDependencies = Layer.effect(IsavailClient, makeIsavailClient);

/**
 * Provides the ISAVAIL client that talks to Registro.br, pacing queries with a
 * process-local rate-limit store. The relay runs as one Fly Machine, so the
 * process is the source address Registro.br limits. Running more Machines
 * requires `RateLimiter.layerStoreRedis` so they share one budget.
 */
export const isavailClientLayer = isavailClientLayerWithoutDependencies.pipe(
  Layer.provide(RateLimiter.layer),
  Layer.provide(RateLimiter.layerStoreMemory),
);

const testRegistryRecords: ReadonlyMap<string, DomainAvailability> = new Map<
  string,
  DomainAvailability
>([
  [
    "registro.br",
    DomainAvailability.cases.Registered.make({
      expiry: RegistrationExpiry.cases.ExemptFromPayment.make({}),
      publicationStatus: "published",
      nameservers: ["a.dns.br", "b.dns.br"],
      suggestedAlternatives: [],
    }),
  ],
  [
    "gov.com.br",
    DomainAvailability.cases.Unavailable.make({
      reason: "Reserved",
      registryMessage: "Word is reserved by CG",
      suggestedAlternatives: [],
    }),
  ],
]);

/**
 * Provides an ISAVAIL client that answers from a fixed table instead of
 * Registro.br: `registro.br` is registered, `gov.com.br` is reserved, and every
 * other domain is `Available`, as an unclaimed domain is at Registro.br.
 */
export const isavailClientTestLayer = Layer.succeed(
  IsavailClient,
  IsavailClient.of({
    lookUpDomains: (domainNames) =>
      Effect.gen(function* () {
        const checkedAt = yield* DateTime.now;

        return domainNames.map((domainName) =>
          RegistryLookup.cases.Resolved.make({
            domainName,
            availability: Option.getOrElse(
              Option.fromUndefinedOr(testRegistryRecords.get(domainName)),
              () => DomainAvailability.cases.Available.make({}),
            ),
            checkedAt,
          }),
        );
      }),
  }),
);
