import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";
import { DomainAvailability } from "./domain-availability.ts";
import { DomainName } from "./domain-name.ts";

/** Largest number of domains one lookup request may ask the relay about. */
export const MAX_REGISTRY_LOOKUP_BATCH_SIZE = 50;

/** Whole seconds a caller should wait before asking Registro.br again. */
export const RetryAfterSeconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  .annotate({ description: "Whole seconds to wait before retrying.", examples: [30] })
  .pipe(Schema.brand("RetryAfterSeconds"));

/** Whole seconds a caller should wait before asking Registro.br again. */
export type RetryAfterSeconds = typeof RetryAfterSeconds.Type;

/**
 * Why the relay could not learn a domain's availability. Every variant is
 * safe to retry because a lookup only reads Registry state.
 */
export const RegistryLookupFailure = Schema.TaggedUnion({
  /**
   * This service has used its query budget at Registro.br, either because
   * Registro.br refused for rate or because the service paces itself to stay
   * under that limit.
   */
  RegistryRateLimited: { retryAfterSeconds: RetryAfterSeconds },
  /** Registro.br did not answer before the lookup deadline. */
  RegistryUnreachable: {},
  /** Registro.br answered in a form this service could not read. */
  RegistryResponseUnreadable: {},
  /** Registro.br answered with an error of its own. */
  RegistryFailed: { registryMessage: Schema.String },
}).annotate({ identifier: "RegistryLookupFailure" });

/** Why the relay could not learn a domain's availability. */
export type RegistryLookupFailure = typeof RegistryLookupFailure.Type;

/** The outcome of asking Registro.br about one domain. */
export const RegistryLookup = Schema.TaggedUnion({
  /** Registro.br answered at `checkedAt`. */
  Resolved: {
    domainName: DomainName,
    availability: DomainAvailability,
    checkedAt: Schema.DateTimeUtcFromString,
  },
  /** The relay could not learn this domain's availability. */
  Failed: { domainName: DomainName, failure: RegistryLookupFailure },
}).annotate({ identifier: "RegistryLookup" });

/** The outcome of asking Registro.br about one domain. */
export type RegistryLookup = typeof RegistryLookup.Type;

/** The domains one lookup request asks about, without duplicates. */
export const RegistryLookupRequest = Schema.Struct({
  domainNames: Schema.Array(DomainName).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_REGISTRY_LOOKUP_BATCH_SIZE),
    Schema.isUnique(),
  ),
}).annotate({
  identifier: "RegistryLookupRequest",
  examples: [
    {
      domainNames: [DomainName.make("minhaempresa.com.br"), DomainName.make("minhaempresa.net.br")],
    },
  ],
});

/** The domains one lookup request asks about. */
export type RegistryLookupRequest = typeof RegistryLookupRequest.Type;

/** One lookup per requested domain, in request order. */
export const RegistryLookupResult = Schema.Struct({
  lookups: Schema.Array(RegistryLookup),
}).annotate({ identifier: "RegistryLookupResult" });

/** One lookup per requested domain, in request order. */
export type RegistryLookupResult = typeof RegistryLookupResult.Type;

/** The caller did not present the relay access token. */
export class RelayAccessDenied extends Schema.TaggedError<
  RelayAccessDenied,
  { readonly brand: unique symbol }
>()("RelayAccessDenied", { message: Schema.String }, { httpApiStatus: 401 }) {}

/**
 * Requires the relay access token as a bearer credential. The relay serves
 * only the web app's API Worker, which holds the token as a secret.
 *
 * @stability unstable
 */
export class RelayAuthorization extends HttpApiMiddleware.Service<
  RelayAuthorization,
  { provides: never; requires: never }
>()("@isavail/availability-contract/RelayAuthorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: RelayAccessDenied,
}) {}

/**
 * Endpoints that ask Registro.br about domains.
 *
 * @stability unstable
 */
export class RegistryLookupsHttpApiGroup extends HttpApiGroup.make("registryLookups")
  .add(
    HttpApiEndpoint.post("lookUpDomains", "/v1/lookups", {
      payload: RegistryLookupRequest,
      success: RegistryLookupResult,
    }).annotateMerge(
      OpenApi.annotations({
        summary: "Look up domains at Registro.br",
        description:
          "Asks the Registro.br ISAVAIL service about each domain and returns one lookup per domain in request order. A domain that Registro.br could not answer for is a Failed lookup rather than a failed request.",
      }),
    ),
  )
  .middleware(RelayAuthorization) {}

/**
 * Endpoints the hosting platform uses to check the relay.
 *
 * @stability unstable
 */
export class RelaySystemHttpApiGroup extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("checkHealth", "/v1/health", {
    success: HttpApiSchema.NoContent,
  }),
) {}

/**
 * HTTP interface of the Registro.br relay.
 *
 * @stability unstable
 */
export class RegistryRelayHttpApi extends HttpApi.make("RegistryRelayHttpApi")
  .add(RegistryLookupsHttpApiGroup)
  .add(RelaySystemHttpApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "isavail Registro.br relay",
      description:
        "Relays domain availability lookups from HTTP to the Registro.br ISAVAIL UDP service.",
    }),
  ) {}
