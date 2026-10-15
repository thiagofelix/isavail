import { DomainAvailability, DomainName, RetryAfterSeconds } from "@isavail/availability-contract";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

/** Largest number of domains one availability check may ask about. */
export const MAX_DOMAIN_CHECK_BATCH_SIZE = 50;

/** Correlates one public API response with the service's logs and traces. */
export const RequestId = Schema.String.check(
  Schema.isPattern(/^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
)
  .annotate({
    description: "Identifies this response. Quote it when asking for support.",
    examples: ["req_6f1c2a7e-3b9d-4c2e-9a51-0d4b8e7f2c13"],
  })
  .pipe(Schema.brand("RequestId"));

/** Correlates one public API response with the service's logs and traces. */
export type RequestId = typeof RequestId.Type;

/**
 * Why a domain could not be checked. Every reason is safe to retry: checking
 * availability never changes anything at Registro.br.
 *
 * The first four variants mirror the relay's `RegistryLookupFailure`; a new
 * relay failure fails to compile where relay lookups become checks until its
 * public form is decided here.
 */
export const DomainCheckFailure = Schema.TaggedUnion({
  /** Registro.br's query budget for this service is spent; retry after `retryAfterSeconds`. */
  RegistryRateLimited: { retryAfterSeconds: RetryAfterSeconds },
  /** Registro.br did not answer in time. */
  RegistryUnreachable: {},
  /** Registro.br answered in a form this service could not read. */
  RegistryResponseUnreadable: {},
  /** Registro.br answered with an error of its own. */
  RegistryFailed: { registryMessage: Schema.String },
  /** The service that asks Registro.br could not be reached. */
  LookupServiceUnavailable: {},
}).annotate({ identifier: "DomainCheckFailure" });

/** Why a domain could not be checked. */
export type DomainCheckFailure = typeof DomainCheckFailure.Type;

/** The result of checking one domain. */
export const DomainCheck = Schema.TaggedUnion({
  /** Registro.br reported `availability` at `checkedAt`. */
  Checked: {
    domainName: DomainName,
    availability: DomainAvailability,
    checkedAt: Schema.DateTimeUtcFromString,
    servedFromCache: Schema.Boolean.annotate({
      description:
        "True when this answer was reused from a recent check instead of asking Registro.br again.",
    }),
  },
  /** The domain could not be checked; see `failure` for when to retry. */
  NotChecked: { domainName: DomainName, failure: DomainCheckFailure },
}).annotate({ identifier: "DomainCheck" });

/** The result of checking one domain. */
export type DomainCheck = typeof DomainCheck.Type;

/** One check per distinct requested domain, in the order the domains were first requested. */
export const DomainCheckReport = Schema.Struct({
  requestId: RequestId,
  checks: Schema.Array(DomainCheck),
}).annotate({ identifier: "DomainCheckReport" });

/** One check per distinct requested domain. */
export type DomainCheckReport = typeof DomainCheckReport.Type;

/** The domains or bare company names an availability check asks about. */
export const DomainCheckRequest = Schema.Struct({
  domains: Schema.Array(
    Schema.String.annotate({
      description:
        "A .br domain such as minhaempresa.com.br, or a bare name such as minhaempresa, which is checked as minhaempresa.com.br.",
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DOMAIN_CHECK_BATCH_SIZE)),
}).annotate({
  identifier: "DomainCheckRequest",
  examples: [{ domains: ["minhaempresa", "minhaempresa.net.br", "minha-empresa.com.br"] }],
});

/** The domains or bare company names an availability check asks about. */
export type DomainCheckRequest = typeof DomainCheckRequest.Type;

/** One requested entry that is not a `.br` domain name. */
export const DomainNameViolation = Schema.Struct({
  input: Schema.String.annotate({ description: "The entry exactly as it was sent." }),
  message: Schema.String.annotate({ description: "What is wrong with the entry." }),
}).annotate({ identifier: "DomainNameViolation" });

/** One requested entry that is not a `.br` domain name. */
export type DomainNameViolation = typeof DomainNameViolation.Type;

/** At least one requested entry is not a `.br` domain name. Nothing was checked. */
export class InvalidDomainNames extends Schema.TaggedError<InvalidDomainNames>()(
  "InvalidDomainNames",
  {
    code: Schema.Literal("InvalidDomainNames"),
    message: Schema.String,
    requestId: RequestId,
    retryable: Schema.Literal(false),
    details: Schema.Struct({ violations: Schema.Array(DomainNameViolation) }),
  },
  { httpApiStatus: 400 },
) {}

/** Endpoints that check whether `.br` domains can be registered. */
export class DomainAvailabilityHttpApiGroup extends HttpApiGroup.make("domainAvailability")
  .add(
    HttpApiEndpoint.post("checkDomains", "/v1/availability-checks", {
      payload: DomainCheckRequest,
      success: DomainCheckReport,
      error: InvalidDomainNames,
    }).annotateMerge(
      OpenApi.annotations({
        summary: "Check several .br domains",
        description: `Checks up to ${MAX_DOMAIN_CHECK_BATCH_SIZE} domains or bare company names at Registro.br. Entries that normalize to the same domain are checked once. Registro.br answers a burst of about 30 questions and then about one per second, so in a large batch some checks can be NotChecked with a RegistryRateLimited failure; send those domains again after retryAfterSeconds.`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("checkDomain", "/v1/domains/:domain/availability", {
      params: {
        domain: Schema.String.annotate({
          description: "A .br domain such as minhaempresa.com.br, or a bare company name.",
          examples: ["minhaempresa.com.br"],
        }),
      },
      success: DomainCheckReport,
      error: InvalidDomainNames,
    }).annotateMerge(
      OpenApi.annotations({
        summary: "Check one .br domain",
        description:
          "Checks one domain or bare company name at Registro.br and returns a report with a single check.",
      }),
    ),
  ) {}

/** Public HTTP interface of the domain availability service. */
export class AvailabilityHttpApi extends HttpApi.make("AvailabilityHttpApi")
  .add(DomainAvailabilityHttpApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "isavail — .br domain availability",
      description:
        "Checks whether .br domains can be registered, using Registro.br's official ISAVAIL availability service. Designed for people and AI agents generating company names: send bare names or full domains, and read each check's availability._tag. Available and AvailableWithCompetingTickets can be registered now; ReleaseInProgress and CompetitiveReleaseInProgress accept tickets inside their window; Registered, Unavailable, and AwaitingRelease cannot be registered now.",
    }),
  ) {}
