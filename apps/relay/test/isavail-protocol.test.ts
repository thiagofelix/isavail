import { CalendarDate, CompetingTicketCount, DomainName } from "@isavail/availability-contract";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option } from "effect";
import {
  decodeIsavailResponse,
  encodeIsavailQuery,
  IsavailCookie,
  IsavailQueryId,
  type IsavailResponse,
} from "../src/isavail-protocol.ts";

const encodeLatin1 = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

const answered = (response: IsavailResponse) => {
  if (response._tag !== "Answered") {
    throw new Error(`Expected an Answered response, received ${response._tag}`);
  }

  return response;
};

const decodeAnswer = (datagram: string) =>
  decodeIsavailResponse(encodeLatin1(datagram)).pipe(Effect.map(answered));

describe("encodeIsavailQuery", () => {
  it("encodes version 2 English queries with suggestions in ISO-8859-1", () => {
    const payload = encodeIsavailQuery({
      cookie: IsavailCookie.make("8a6e52837fc2c68f7a4a"),
      queryId: IsavailQueryId.make(123456789),
      domainName: DomainName.make("açaí.com.br"),
    });

    assert.deepStrictEqual(
      Array.from(payload),
      Array.from(encodeLatin1("2 8a6e52837fc2c68f7a4a 0 123456789 açaí.com.br 1")),
    );
    assert.strictEqual(
      payload.byteLength,
      "2 8a6e52837fc2c68f7a4a 0 123456789 açaí.com.br 1".length,
    );
  });
});

describe("decodeIsavailResponse", () => {
  it.effect("reads a cookie renewal", () =>
    Effect.gen(function* () {
      const response = yield* decodeIsavailResponse(encodeLatin1("CK 8a6e52837fc2c68f7a4a 12345"));

      assert.deepStrictEqual(response, {
        _tag: "CookieIssued",
        cookie: IsavailCookie.make("8a6e52837fc2c68f7a4a"),
        queryId: IsavailQueryId.make(12345),
      });
    }),
  );

  it.effect("reads an available domain", () =>
    Effect.gen(function* () {
      const response = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 0 4172290007\r\nnomeempresa-teste.com.br\r\n",
      );

      assert.strictEqual(response.queryId, 4172290007);
      assert.strictEqual(response.availability._tag, "Available");
    }),
  );

  it.effect(
    "reads a registered domain with its expiry, nameservers, and suggested categories",
    () =>
      Effect.gen(function* () {
        const response = yield* decodeAnswer(
          "% Copyright Nic.br\r\nST 2 860005320\r\ngoogle.com.br\r\n2027-05-18|published|ns1.google.com|ns2.google.com\r\nagr|ong\r\n",
        );

        assert.deepStrictEqual(response.availability, {
          _tag: "Registered",
          expiry: { _tag: "ExpiresOn", date: CalendarDate.make("2027-05-18") },
          publicationStatus: "published",
          nameservers: ["ns1.google.com", "ns2.google.com"],
          suggestedAlternatives: [
            DomainName.make("google.agr.br"),
            DomainName.make("google.ong.br"),
          ],
        });
      }),
  );

  it.effect("reads a payment-exempt registration without suggestions", () =>
    Effect.gen(function* () {
      const response = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 2 771415561\r\nregistro.br\r\nExempt from payment|published|a.dns.br|b.dns.br\r\n\r\n",
      );

      assert.deepStrictEqual(response.availability, {
        _tag: "Registered",
        expiry: { _tag: "ExemptFromPayment" },
        publicationStatus: "published",
        nameservers: ["a.dns.br", "b.dns.br"],
        suggestedAlternatives: [],
      });
    }),
  );

  it.effect("classifies the reasons Registro.br gives for unavailable domains", () =>
    Effect.gen(function* () {
      const reserved = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 3 398345215\r\ngov.com.br\r\nWord is reserved by CG\r\n\r\n",
      );
      const invalidDomain = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 3 316919817\r\na.com.br\r\nInvalid domain\r\n\r\n",
      );
      const invalidCategory = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 3 859430636\r\nexemplo.br\r\nInvalid TLD\r\n\r\n",
      );
      const invalidQuery = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 4 219652065\r\nxn--aa-xyz.com.br\r\nInvalid domain",
      );

      assert.deepStrictEqual(reserved.availability, {
        _tag: "Unavailable",
        reason: "Reserved",
        registryMessage: "Word is reserved by CG",
        suggestedAlternatives: [],
      });
      assert.deepStrictEqual(
        [invalidDomain, invalidCategory, invalidQuery].map(({ availability }) =>
          availability._tag === "Unavailable" ? availability.reason : availability._tag,
        ),
        ["InvalidDomain", "InvalidCategory", "InvalidDomain"],
      );
    }),
  );

  it.effect("names suggestions after the Unicode form of an internationalized domain", () =>
    Effect.gen(function* () {
      const response = yield* decodeAnswer(
        "% Copyright Nic.br\r\nST 3 894508572\r\naçaí.com.br|xn--aa-4iaz.com.br\r\nDomain reserved for the transition to the TLD edu.br\r\nedu\r\n",
      );

      assert.deepStrictEqual(response.availability, {
        _tag: "Unavailable",
        reason: "Reserved",
        registryMessage: "Domain reserved for the transition to the TLD edu.br",
        suggestedAlternatives: [DomainName.make("açaí.edu.br")],
      });
    }),
  );

  it.effect("counts competing tickets", () =>
    Effect.gen(function* () {
      const response = yield* decodeAnswer(
        "% Copyright registro.br\r\nST 1 12345\r\nexample.com.br\r\n2567849|2567856\r\n",
      );

      assert.deepStrictEqual(response.availability, {
        _tag: "AvailableWithCompetingTickets",
        competingTicketCount: CompetingTicketCount.make(2),
      });
    }),
  );

  it.effect("reads a domain awaiting release", () =>
    Effect.gen(function* () {
      const response = yield* decodeAnswer(
        "% Copyright registro.br\r\nST 5 12345\r\nexample.com.br\r\n",
      );

      assert.strictEqual(response.availability._tag, "AwaitingRelease");
    }),
  );

  it.effect("converts release windows from Brasília time to UTC", () =>
    Effect.gen(function* () {
      const withoutTickets = yield* decodeAnswer(
        "% Copyright registro.br\r\nST 6 12345\r\nexample.com.br\r\n2007-01-15 15:00:00|2007-01-30 15:00:00\r\n",
      );
      const withTickets = yield* decodeAnswer(
        "% Copyright registro.br\r\nST 7 12345\r\nexample.com.br\r\n2007-01-15 15:00:00|2007-01-30 15:00:00\r\n2567849|2567856\r\n",
      );

      if (
        withoutTickets.availability._tag !== "ReleaseInProgress" ||
        withTickets.availability._tag !== "ReleaseInProgress"
      ) {
        return assert.fail("Expected ReleaseInProgress availabilities");
      }

      assert.strictEqual(
        DateTime.formatIso(withoutTickets.availability.window.startsAt),
        "2007-01-15T18:00:00.000Z",
      );
      assert.strictEqual(withoutTickets.availability.competingTicketCount, 0);
      assert.strictEqual(withTickets.availability.competingTicketCount, 2);
    }),
  );

  it.effect("reads a competitive release and its ticket deadline", () =>
    Effect.gen(function* () {
      const response = yield* decodeAnswer(
        "% Copyright registro.br\r\nST 9 12345\r\nexample.com.br\r\n2007-01-15 15:00:00|2007-01-22 15:00:00|2007-01-25 15:00:00\r\n2567849|2567856\r\n",
      );

      if (response.availability._tag !== "CompetitiveReleaseInProgress") {
        return assert.fail("Expected a CompetitiveReleaseInProgress availability");
      }

      assert.strictEqual(
        DateTime.formatIso(response.availability.acceptingTicketsUntil),
        "2007-01-25T18:00:00.000Z",
      );
      assert.strictEqual(response.availability.competingTicketCount, 2);
    }),
  );

  it.effect("reads a refusal that carries no query identifier", () =>
    Effect.gen(function* () {
      const response = yield* decodeIsavailResponse(
        encodeLatin1("% Copyright registro.br\r\nST 8\r\nQuery rate limit exceeded\r\n"),
      );

      assert.deepStrictEqual(response, {
        _tag: "Refused",
        queryId: Option.none(),
        registryMessage: "Query rate limit exceeded",
      });
    }),
  );

  it.effect("rejects datagrams that do not follow the protocol", () =>
    Effect.gen(function* () {
      const noHeader = yield* Effect.exit(decodeIsavailResponse(encodeLatin1("hello")));
      const unknownStatus = yield* Effect.exit(
        decodeIsavailResponse(encodeLatin1("ST 42 12345\r\nexample.com.br\r\n")),
      );
      const missingRegistration = yield* Effect.exit(
        decodeIsavailResponse(encodeLatin1("ST 2 12345\r\nexample.com.br\r\n")),
      );

      assert.isTrue(Exit.isFailure(noHeader));
      assert.isTrue(Exit.isFailure(unknownStatus));
      assert.isTrue(Exit.isFailure(missingRegistration));
    }),
  );
});
