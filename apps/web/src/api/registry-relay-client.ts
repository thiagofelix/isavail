import {
  DomainAvailability,
  type DomainName,
  REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE,
  RegistrationExpiry,
  RegistryLookup,
  RegistryLookupFailure,
  RegistryRelayHttpApi,
  RelayAuthorization,
  RetryAfterSeconds,
} from "@isavail/availability-contract";
import {
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";

/** Environment variable that carries the relay base URL to the API Worker. */
export const REGISTRY_RELAY_URL_VARIABLE = "ISAVAIL_RELAY_URL";

/** Longest the API Worker waits for the relay to answer one lookup request. */
const RELAY_REQUEST_TIMEOUT = Duration.seconds(15);

/**
 * The relay could not be asked about any of the requested domains.
 *
 * - `NotConfigured`: the Worker has no relay URL or access token.
 * - `AccessDenied`: the relay rejected the Worker's access token.
 * - `Unreachable`: the relay did not answer in time or the connection failed.
 * - `UnexpectedResponse`: the relay answered in a form the Worker could not read.
 */
export class RegistryRelayUnavailable extends Schema.TaggedError<RegistryRelayUnavailable>()(
  "RegistryRelayUnavailable",
  {
    reason: Schema.Literals(["NotConfigured", "AccessDenied", "Unreachable", "UnexpectedResponse"]),
    message: Schema.String,
  },
) {}

/** Asks the Registro.br relay about domains on behalf of the API Worker. */
export interface IRegistryRelayClient {
  /**
   * Asks the relay about each domain.
   *
   * @returns One lookup per domain in request order, or
   * `RegistryRelayUnavailable` when the relay could not be asked at all.
   */
  readonly lookUpDomains: (
    domainNames: ReadonlyArray<DomainName>,
  ) => Effect.Effect<ReadonlyArray<RegistryLookup>, RegistryRelayUnavailable>;
}

/** Provides the contextual Registro.br relay client. */
export class RegistryRelayClient extends Context.Service<
  RegistryRelayClient,
  IRegistryRelayClient
>()("@isavail/web/RegistryRelayClient") {}

const relayUnavailable = (reason: RegistryRelayUnavailable["reason"], message: string) =>
  new RegistryRelayUnavailable({ reason, message });

/**
 * The relay URL and token are read from the Worker environment on each call,
 * not while the Worker starts, because Alchemy also evaluates the Worker
 * program while planning a deployment, where those bindings do not exist yet.
 */
const lookUpDomainsThroughRelay = Effect.fn("RegistryRelayClient.lookUpDomains")(
  function* (domainNames: ReadonlyArray<DomainName>) {
    const baseUrl = yield* Config.String(REGISTRY_RELAY_URL_VARIABLE);
    const accessToken = yield* Config.Redacted(REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE);

    const client = yield* HttpApiClient.make(RegistryRelayHttpApi, { baseUrl }).pipe(
      Effect.provide(
        HttpApiMiddleware.layerClient(RelayAuthorization, ({ next, request }) =>
          next(HttpClientRequest.bearerToken(request, Redacted.value(accessToken))),
        ),
      ),
    );

    const { lookups } = yield* client.registryLookups
      .lookUpDomains({ payload: { domainNames } })
      .pipe(Effect.timeout(RELAY_REQUEST_TIMEOUT));

    return lookups;
  },
  Effect.catchTags({
    ConfigError: () =>
      Effect.fail(
        relayUnavailable(
          "NotConfigured",
          `The API Worker has no ${REGISTRY_RELAY_URL_VARIABLE} or ${REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE} binding. Deploy the relay Stack for this stage, then redeploy the web Stack.`,
        ),
      ),
    RelayAccessDenied: () =>
      Effect.fail(
        relayUnavailable(
          "AccessDenied",
          "The relay rejected the API Worker's access token. Redeploy the web Stack so it reads the relay Stack's current token.",
        ),
      ),
    TimeoutError: () =>
      Effect.fail(
        relayUnavailable(
          "Unreachable",
          `The relay did not answer within ${Duration.format(RELAY_REQUEST_TIMEOUT)}.`,
        ),
      ),
    HttpClientError: (error) =>
      Effect.fail(
        relayUnavailable(
          error.reason._tag === "StatusCodeError" ? "UnexpectedResponse" : "Unreachable",
          `The relay request failed: ${error.message}`,
        ),
      ),
    SchemaError: (error) =>
      Effect.fail(
        relayUnavailable(
          "UnexpectedResponse",
          `The relay answer could not be read: ${error.message}`,
        ),
      ),
  }),
  Effect.provide(FetchHttpClient.layer),
);

/** Constructs the relay client. */
export const makeRegistryRelayClient = Effect.succeed(
  RegistryRelayClient.of({ lookUpDomains: lookUpDomainsThroughRelay }),
);

/** Provides the relay client; it reads its relay URL and token from the contextual `ConfigProvider`. */
export const registryRelayClientLayerWithoutDependencies = Layer.effect(
  RegistryRelayClient,
  makeRegistryRelayClient,
);

/** Provides the relay client that calls the relay over HTTPS with the Worker's fetch. */
export const registryRelayClientLayer = registryRelayClientLayerWithoutDependencies;

const testRelayRecords: ReadonlyMap<string, DomainAvailability> = new Map<
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

/** Domain the test relay always reports as rate limited, as the relay does once its budget is spent. */
export const TEST_RATE_LIMITED_DOMAIN = "limitada.com.br";

/**
 * Provides a relay client that answers like the relay over a fixed Registry:
 * `registro.br` is registered, `gov.com.br` is reserved,
 * {@link TEST_RATE_LIMITED_DOMAIN} is rate limited for 30 seconds, and every
 * other domain is `Available`.
 */
export const registryRelayClientTestLayer = Layer.succeed(
  RegistryRelayClient,
  RegistryRelayClient.of({
    lookUpDomains: (domainNames) =>
      Effect.gen(function* () {
        const checkedAt = yield* DateTime.now;

        return domainNames.map((domainName) =>
          domainName === TEST_RATE_LIMITED_DOMAIN
            ? RegistryLookup.cases.Failed.make({
                domainName,
                failure: RegistryLookupFailure.cases.RegistryRateLimited.make({
                  retryAfterSeconds: RetryAfterSeconds.make(30),
                }),
              })
            : RegistryLookup.cases.Resolved.make({
                domainName,
                availability: Option.getOrElse(
                  Option.fromUndefinedOr(testRelayRecords.get(domainName)),
                  () => DomainAvailability.cases.Available.make({}),
                ),
                checkedAt,
              }),
        );
      }),
  }),
);
