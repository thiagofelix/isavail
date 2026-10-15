import { DomainAvailability, DomainName, UnavailableReason } from "@isavail/availability-contract";
import { Array, Effect, Match, Option, pipe, Schema } from "effect";

/**
 * ISAVAIL protocol version this client speaks. Version 2 adds suggestions of
 * other categories and the competitive release status.
 */
const PROTOCOL_VERSION = 2;

/** Registry messages in English are stable enough to classify. */
const LANGUAGE_ENGLISH = 0;

/** Asks Registro.br to suggest the same name under other categories. */
const SUGGEST_ALTERNATIVES = 1;

const BRASILIA_UTC_OFFSET = "-03:00";
const EXEMPT_FROM_PAYMENT_EXPIRIES = new Set(["0", "Exempt from payment"]);

const COOKIE_LENGTH = 20;

/**
 * Proof of source address Registro.br issues to each client. A query with an
 * outdated cookie is answered with a new cookie instead of an availability.
 */
export const IsavailCookie = Schema.String.check(Schema.isPattern(/^[0-9a-f]{20}$/)).pipe(
  Schema.brand("IsavailCookie"),
);

/** Proof of source address Registro.br issues to each client. */
export type IsavailCookie = typeof IsavailCookie.Type;

/**
 * Cookie a client sends before Registro.br has issued one. Registro.br answers
 * it with a valid cookie.
 */
export const UNISSUED_ISAVAIL_COOKIE = IsavailCookie.make("0".repeat(COOKIE_LENGTH));

/** Smallest valid {@link IsavailQueryId}. */
export const MIN_ISAVAIL_QUERY_ID = 1;

/** Largest valid {@link IsavailQueryId}: the protocol allows up to ten decimal digits, and the official clients stay within 32 bits. */
export const MAX_ISAVAIL_QUERY_ID = 4_294_967_295;

/** Correlates an ISAVAIL answer with the query that caused it. */
export const IsavailQueryId = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_ISAVAIL_QUERY_ID, maximum: MAX_ISAVAIL_QUERY_ID }),
).pipe(Schema.brand("IsavailQueryId"));

/** Correlates an ISAVAIL answer with the query that caused it. */
export type IsavailQueryId = typeof IsavailQueryId.Type;

/** One ISAVAIL availability question. */
export interface IsavailQuery {
  readonly cookie: IsavailCookie;
  readonly queryId: IsavailQueryId;
  readonly domainName: DomainName;
}

/** A datagram Registro.br sent in reply to an ISAVAIL query. */
export const IsavailResponse = Schema.TaggedUnion({
  /** The query carried an outdated cookie; resend it with `cookie`. */
  CookieIssued: { cookie: IsavailCookie, queryId: IsavailQueryId },
  /**
   * Registro.br answered the query identified by `queryId` about
   * `echoedDomainName`, the domain as Registro.br repeated it in the answer.
   */
  Answered: {
    queryId: IsavailQueryId,
    echoedDomainName: Schema.String,
    availability: DomainAvailability,
  },
  /**
   * Registro.br refused to answer. It omits the query identifier when it
   * refuses, for example when it limits the query rate of this client.
   */
  Refused: {
    queryId: Schema.Option(IsavailQueryId),
    registryMessage: Schema.String,
  },
});

/** A datagram Registro.br sent in reply to an ISAVAIL query. */
export type IsavailResponse = typeof IsavailResponse.Type;

/** A datagram that does not follow the ISAVAIL response format. */
export class IsavailResponseUnreadable extends Schema.TaggedError<
  IsavailResponseUnreadable,
  { readonly brand: unique symbol }
>()("IsavailResponseUnreadable", {
  message: Schema.String,
  response: Schema.String,
}) {}

const encodeIsoLatin1 = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

const decodeIsoLatin1 = (payload: Uint8Array): string =>
  pipe(
    Array.fromIterable(payload),
    Array.map((byte) => String.fromCharCode(byte)),
    Array.join(""),
  );

/**
 * Encodes an ISAVAIL query datagram.
 *
 * The protocol uses ISO-8859-1. Every character a {@link DomainName} admits is
 * inside that character set, so the encoding is lossless.
 *
 * @param query - The cookie, query identifier, and domain to ask about.
 * @returns The datagram payload to send to Registro.br.
 */
export const encodeIsavailQuery = ({ cookie, queryId, domainName }: IsavailQuery): Uint8Array =>
  encodeIsoLatin1(
    `${PROTOCOL_VERSION} ${cookie} ${LANGUAGE_ENGLISH} ${queryId} ${domainName} ${SUGGEST_ALTERNATIVES}`,
  );

/**
 * Whether a refusal means Registro.br is limiting this client's query rate.
 *
 * @param registryMessage - The refusal text exactly as Registro.br sent it.
 */
export const isRateLimitRefusal = (registryMessage: string): boolean =>
  /rate limit/i.test(registryMessage);

const classifyUnavailableReason = (registryMessage: string): UnavailableReason =>
  Match.value(registryMessage).pipe(
    Match.withReturnType<UnavailableReason>(),
    Match.when(
      (message) => /invalid tld/i.test(message),
      () => "InvalidCategory",
    ),
    Match.when(
      (message) => /invalid domain|invalid query/i.test(message),
      () => "InvalidDomain",
    ),
    Match.when(
      (message) => /reserved/i.test(message),
      () => "Reserved",
    ),
    Match.orElse(() => "Other"),
  );

const splitFields = (line: string): Array<string> =>
  line === "" ? [] : Array.map(line.split("|"), (field) => field.trim());

/**
 * Registro.br sends release timestamps as `YYYY-MM-DD HH:MM:SS` without a zone.
 * They are Brasília time, which has stayed at UTC-03:00 since Brazil abolished
 * daylight saving time in 2019.
 */
const toIsoTimestamp = (registryTimestamp: string): Option.Option<string> =>
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(registryTimestamp)
    ? Option.some(`${registryTimestamp.replace(" ", "T")}${BRASILIA_UTC_OFFSET}`)
    : Option.none();

class ResponseLines {
  readonly response: string;
  readonly lines: ReadonlyArray<string>;

  constructor(response: string, lines: ReadonlyArray<string>) {
    this.response = response;
    this.lines = lines;
  }

  unreadable(message: string): IsavailResponseUnreadable {
    return IsavailResponseUnreadable.make({ message, response: this.response });
  }

  optionalLine(index: number): string {
    return Option.getOrElse(Array.get(this.lines, index), () => "");
  }

  requiredLine(
    index: number,
    description: string,
  ): Effect.Effect<string, IsavailResponseUnreadable> {
    const line = this.optionalLine(index);

    return line === ""
      ? Effect.fail(this.unreadable(`ISAVAIL response has no ${description} line`))
      : Effect.succeed(line);
  }
}

const decodeAvailability = Schema.decodeEffect(DomainAvailability);

const competingTicketCountFrom = (line: string): number => splitFields(line).length;

const suggestedAlternativesFrom = (
  domainName: string,
  line: string,
): Array<typeof DomainName.Encoded> => {
  const name = Option.getOrElse(Array.head(domainName.split(".")), () => domainName);

  return Array.map(splitFields(line), (category) => `${name}.${category}.br`);
};

const releaseWindowFrom = (
  responseLines: ResponseLines,
  line: string,
): Effect.Effect<
  { readonly startsAt: string; readonly endsAt: string; readonly fields: ReadonlyArray<string> },
  IsavailResponseUnreadable
> =>
  Effect.gen(function* () {
    const fields = splitFields(line);
    const timestamps = Array.getSomes(Array.map(fields, toIsoTimestamp));
    const [startsAt, endsAt] = timestamps;

    if (startsAt === undefined || endsAt === undefined || timestamps.length !== fields.length) {
      return yield* responseLines.unreadable(
        "ISAVAIL release window is not two or more timestamps",
      );
    }

    return { startsAt, endsAt, fields: timestamps };
  });

const echoedDomainNameFrom = (
  responseLines: ResponseLines,
): Effect.Effect<string, IsavailResponseUnreadable> =>
  responseLines
    .requiredLine(0, "domain name")
    .pipe(
      Effect.map((domainLine) =>
        Option.getOrElse(Array.head(splitFields(domainLine)), () => domainLine),
      ),
    );

const encodedAvailabilityFrom = (
  status: number,
  domainName: string,
  responseLines: ResponseLines,
): Effect.Effect<typeof DomainAvailability.Encoded, IsavailResponseUnreadable> =>
  Effect.gen(function* () {
    if (status === 0) {
      return { _tag: "Available" };
    } else if (status === 1) {
      const ticketsLine = yield* responseLines.requiredLine(1, "competing tickets");

      return {
        _tag: "AvailableWithCompetingTickets",
        competingTicketCount: competingTicketCountFrom(ticketsLine),
      };
    } else if (status === 2) {
      const registrationLine = yield* responseLines.requiredLine(1, "registration");
      const [expiry = "", publicationStatus = "", ...nameservers] = splitFields(registrationLine);

      return {
        _tag: "Registered",
        expiry: EXEMPT_FROM_PAYMENT_EXPIRIES.has(expiry)
          ? { _tag: "ExemptFromPayment" }
          : { _tag: "ExpiresOn", date: expiry },
        publicationStatus,
        nameservers,
        suggestedAlternatives: suggestedAlternativesFrom(domainName, responseLines.optionalLine(2)),
      };
    } else if (status === 3 || status === 4) {
      const registryMessage = yield* responseLines.requiredLine(1, "reason");

      return {
        _tag: "Unavailable",
        reason: classifyUnavailableReason(registryMessage),
        registryMessage,
        suggestedAlternatives:
          status === 3 ? suggestedAlternativesFrom(domainName, responseLines.optionalLine(2)) : [],
      };
    } else if (status === 5) {
      return { _tag: "AwaitingRelease" };
    } else if (status === 6 || status === 7) {
      const window = yield* releaseWindowFrom(
        responseLines,
        yield* responseLines.requiredLine(1, "release window"),
      );

      return {
        _tag: "ReleaseInProgress",
        window: { startsAt: window.startsAt, endsAt: window.endsAt },
        competingTicketCount:
          status === 7 ? competingTicketCountFrom(responseLines.optionalLine(2)) : 0,
      };
    } else if (status === 9) {
      const window = yield* releaseWindowFrom(
        responseLines,
        yield* responseLines.requiredLine(1, "competitive release window"),
      );
      const acceptingTicketsUntil = window.fields[2];

      if (acceptingTicketsUntil === undefined) {
        return yield* responseLines.unreadable(
          "ISAVAIL competitive release window has no ticket deadline",
        );
      }

      return {
        _tag: "CompetitiveReleaseInProgress",
        window: { startsAt: window.startsAt, endsAt: window.endsAt },
        acceptingTicketsUntil,
        competingTicketCount: competingTicketCountFrom(responseLines.optionalLine(2)),
      };
    } else {
      return yield* responseLines.unreadable(`ISAVAIL status ${status} is not defined`);
    }
  });

const COOKIE_HEADER = /^CK ([0-9a-f]{20})\S* (\d{1,10})$/;
const STATUS_HEADER = /^ST (\d+)(?: (\d{1,10}))?$/;
const REFUSED_STATUS = 8;

/**
 * Decodes a datagram Registro.br sent in reply to an ISAVAIL query.
 *
 * The caller must compare `echoedDomainName` with the domain it asked about:
 * Registro.br mixes up concurrent queries from one client and can answer a
 * query identifier with another query's domain.
 *
 * Decoding follows the responses Registro.br sends, which differ from the
 * published specification in three ways: internationalized names arrive as
 * `unicode|ace` rather than `ace|unicode`, payment-exempt registrations carry
 * `Exempt from payment` rather than `0`, and status 3 also covers malformed
 * names and unknown categories.
 *
 * @param payload - The datagram exactly as received.
 * @returns The decoded response, or `IsavailResponseUnreadable` when the datagram does not follow the protocol.
 */
export const decodeIsavailResponse = (
  payload: Uint8Array,
): Effect.Effect<IsavailResponse, IsavailResponseUnreadable> =>
  Effect.gen(function* () {
    const response = decodeIsoLatin1(payload);
    const lines = pipe(
      response.split(/\r?\n/),
      Array.map((line) => line.trim()),
      Array.filter((line) => !line.startsWith("%")),
    );
    const headerIndex = Array.findFirstIndex(lines, (line) => line !== "");
    const header = pipe(
      headerIndex,
      Option.flatMap((index) => Array.get(lines, index)),
      Option.getOrElse(() => ""),
    );
    const responseLines = new ResponseLines(
      response,
      Option.match(headerIndex, {
        onNone: () => lines,
        onSome: (index) => lines.slice(index + 1),
      }),
    );

    const cookieHeader = COOKIE_HEADER.exec(header);
    if (cookieHeader !== null) {
      const [, cookie = "", queryId = ""] = cookieHeader;

      return IsavailResponse.cases.CookieIssued.make({
        cookie: IsavailCookie.make(cookie),
        queryId: IsavailQueryId.make(Number(queryId)),
      });
    }

    const statusHeader = STATUS_HEADER.exec(header);
    if (statusHeader === null) {
      return yield* responseLines.unreadable("ISAVAIL response has no CK or ST header");
    }

    const [, statusText = "", queryIdText] = statusHeader;
    const status = Number(statusText);
    const maybeQueryId = Option.fromUndefinedOr(queryIdText).pipe(
      Option.flatMap((text) => IsavailQueryId.makeOption(Number(text))),
    );

    if (status === REFUSED_STATUS) {
      const registryMessage = Option.getOrElse(
        Array.findLast(responseLines.lines, (line) => line !== ""),
        () => "",
      );

      return IsavailResponse.cases.Refused.make({ queryId: maybeQueryId, registryMessage });
    }

    if (Option.isNone(maybeQueryId)) {
      return yield* responseLines.unreadable(`ISAVAIL status ${status} has no query identifier`);
    }

    const echoedDomainName = yield* echoedDomainNameFrom(responseLines);
    const encodedAvailability = yield* encodedAvailabilityFrom(
      status,
      echoedDomainName,
      responseLines,
    );
    const availability = yield* decodeAvailability(encodedAvailability).pipe(
      Effect.mapError((error) =>
        responseLines.unreadable(
          `ISAVAIL answer does not describe an availability: ${error.message}`,
        ),
      ),
    );

    return IsavailResponse.cases.Answered.make({
      queryId: maybeQueryId.value,
      echoedDomainName,
      availability,
    });
  });
