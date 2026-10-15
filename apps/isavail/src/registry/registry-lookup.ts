import { Schema } from "effect";
import { DomainAvailability } from "../domain/domain-availability.ts";
import { DomainName } from "../domain/domain-name.ts";

/** Whole seconds a caller should wait before asking Registro.br again. */
export const RetryAfterSeconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  .annotate({ description: "Whole seconds to wait before retrying.", examples: [30] })
  .pipe(Schema.brand("RetryAfterSeconds"));

/** Whole seconds a caller should wait before asking Registro.br again. */
export type RetryAfterSeconds = typeof RetryAfterSeconds.Type;

/**
 * Why a domain's availability could not be learned from Registro.br. Every
 * variant is safe to retry because a lookup only reads Registry state.
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

/** Why a domain's availability could not be learned from Registro.br. */
export type RegistryLookupFailure = typeof RegistryLookupFailure.Type;

/** The outcome of asking Registro.br about one domain. */
export const RegistryLookup = Schema.TaggedUnion({
  /** Registro.br answered at `checkedAt`. */
  Resolved: {
    domainName: DomainName,
    availability: DomainAvailability,
    checkedAt: Schema.DateTimeUtcFromString,
  },
  /** Registro.br could not be asked, or did not answer, about this domain. */
  Failed: { domainName: DomainName, failure: RegistryLookupFailure },
}).annotate({ identifier: "RegistryLookup" });

/** The outcome of asking Registro.br about one domain. */
export type RegistryLookup = typeof RegistryLookup.Type;
