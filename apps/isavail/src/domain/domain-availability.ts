import { Schema } from "effect";
import { DomainName } from "./domain-name.ts";

/** A calendar date in ISO `YYYY-MM-DD` form, such as a registration expiry date. */
export const CalendarDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { expected: "a calendar date in YYYY-MM-DD form" }),
)
  .annotate({ description: "A calendar date in YYYY-MM-DD form.", examples: ["2027-05-18"] })
  .pipe(Schema.brand("CalendarDate"));

/** A calendar date in ISO `YYYY-MM-DD` form. */
export type CalendarDate = typeof CalendarDate.Type;

/**
 * Number of registration tickets other people have already opened for a domain.
 * Registro.br decides between competing tickets, so a non-zero count means the
 * domain may go to someone else even when a new ticket is accepted.
 */
export const CompetingTicketCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .annotate({
    description: "Registration tickets other people have already opened for this domain.",
    examples: [2],
  })
  .pipe(Schema.brand("CompetingTicketCount"));

/** Number of competing registration tickets for a domain. */
export type CompetingTicketCount = typeof CompetingTicketCount.Type;

/** When an existing registration has to be renewed. */
export const RegistrationExpiry = Schema.TaggedUnion({
  /** The holder is exempt from renewal fees, as government and Registro.br domains are. */
  ExemptFromPayment: {},
  /** The registration expires on `date` unless it is renewed. */
  ExpiresOn: { date: CalendarDate },
}).annotate({ identifier: "RegistrationExpiry" });

/** When an existing registration has to be renewed. */
export type RegistrationExpiry = typeof RegistrationExpiry.Type;

/** The period in which Registro.br accepts tickets for a domain it is releasing. */
export const ReleaseWindow = Schema.Struct({
  startsAt: Schema.DateTimeUtcFromString,
  endsAt: Schema.DateTimeUtcFromString,
}).annotate({ identifier: "ReleaseWindow" });

/** The period in which Registro.br accepts tickets for a domain it is releasing. */
export type ReleaseWindow = typeof ReleaseWindow.Type;

/**
 * Why Registro.br refuses to register a domain.
 *
 * - `Reserved`: the name is reserved, for example by the Brazilian Internet
 *   Steering Committee (CGI.br) or for another category.
 * - `InvalidDomain`: the name breaks a Registro.br naming rule, such as the
 *   minimum length.
 * - `InvalidCategory`: the part after the name, such as `.xyz.br`, is not a
 *   category Registro.br offers.
 * - `Other`: Registro.br gave a reason this service does not classify; read
 *   `registryMessage`.
 */
export const UnavailableReason = Schema.Literals([
  "Reserved",
  "InvalidDomain",
  "InvalidCategory",
  "Other",
]).annotate({ identifier: "UnavailableReason" });

/** Why Registro.br refuses to register a domain. */
export type UnavailableReason = typeof UnavailableReason.Type;

const suggestedAlternatives = Schema.Array(DomainName).annotate({
  description:
    "The same name under other Registro.br categories that Registro.br suggests instead, such as minhaempresa.net.br.",
});

/**
 * What Registro.br reports about registering a domain.
 *
 * `Available` and `AvailableWithCompetingTickets` can be registered now.
 * `ReleaseInProgress` and `CompetitiveReleaseInProgress` accept tickets only
 * inside their release window. `Registered`, `Unavailable`, and
 * `AwaitingRelease` cannot be registered now.
 */
export const DomainAvailability = Schema.TaggedUnion({
  /** Nobody holds the domain and nobody has asked for it. */
  Available: {},
  /** Nobody holds the domain, but other people have already opened tickets for it. */
  AvailableWithCompetingTickets: { competingTicketCount: CompetingTicketCount },
  /** Someone holds the domain. */
  Registered: {
    expiry: RegistrationExpiry,
    publicationStatus: Schema.String.annotate({
      description: "Registro.br DNS publication status, such as published or on-hold.",
    }),
    nameservers: Schema.Array(Schema.String),
    suggestedAlternatives,
  },
  /** Registro.br does not allow the domain to be registered. */
  Unavailable: {
    reason: UnavailableReason,
    registryMessage: Schema.String.annotate({
      description: "The reason exactly as Registro.br worded it.",
    }),
    suggestedAlternatives,
  },
  /** The previous registration ended and the domain waits for a release process to start. */
  AwaitingRelease: {},
  /** Registro.br is releasing the domain and accepts tickets inside `window`. */
  ReleaseInProgress: { window: ReleaseWindow, competingTicketCount: CompetingTicketCount },
  /** Registro.br is releasing the domain competitively and accepts new tickets until `acceptingTicketsUntil`. */
  CompetitiveReleaseInProgress: {
    window: ReleaseWindow,
    acceptingTicketsUntil: Schema.DateTimeUtcFromString,
    competingTicketCount: CompetingTicketCount,
  },
}).annotate({ identifier: "DomainAvailability" });

/** What Registro.br reports about registering a domain. */
export type DomainAvailability = typeof DomainAvailability.Type;
