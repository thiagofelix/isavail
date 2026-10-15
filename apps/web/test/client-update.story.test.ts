import { DomainAvailability, DomainName, RetryAfterSeconds } from "@isavail/availability-contract";
import { Array, DateTime, pipe } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { expect, test } from "vite-plus/test";
import { DomainCheck, DomainCheckFailure } from "../src/api/availability-http-api.ts";
import { CheckDomains, WaitBeforeRecheck } from "../src/client/command.ts";
import { init, update } from "../src/client/main.ts";
import { Message } from "../src/client/message.ts";
import { DomainRow, type Model } from "../src/client/model.ts";

const emptyModel: Model = init().model;

const withEntries = (entriesInput: string): Model => ({ ...emptyModel, entriesInput });

const checkedAt = DateTime.makeUnsafe("2026-10-15T13:00:00Z");

const available = (domainName: string): DomainCheck =>
  DomainCheck.cases.Checked.make({
    domainName: DomainName.make(domainName),
    availability: DomainAvailability.cases.Available.make({}),
    checkedAt,
    servedFromCache: false,
  });

const rateLimited = (domainName: string, seconds: number): DomainCheck =>
  DomainCheck.cases.NotChecked.make({
    domainName: DomainName.make(domainName),
    failure: DomainCheckFailure.cases.RegistryRateLimited.make({
      retryAfterSeconds: RetryAfterSeconds.make(seconds),
    }),
  });

test("submitting entries checks each distinct domain and reports the entries that are not .br domains", () => {
  story(
    update,
    given(withEntries("MinhaEmpresa\nminhaempresa.com.br, minha_empresa\nminhaempresa.net.br")),
    message(Message.SubmittedCheckForm()),
    model((nextModel) => {
      expect(Array.map(nextModel.rows, (row) => [row._tag, row.domainName])).toEqual([
        ["Checking", "minhaempresa.com.br"],
        ["Checking", "minhaempresa.net.br"],
      ]);
      expect(nextModel.entryFeedback).toEqual({
        _tag: "RejectedEntries",
        entries: ["minha_empresa"],
      });
    }),
    Command.expectExact(
      CheckDomains({
        domainNames: [
          DomainName.make("minhaempresa.com.br"),
          DomainName.make("minhaempresa.net.br"),
        ],
      }),
    ),
    Command.resolve(
      CheckDomains,
      Message.SucceededCheckDomains({
        checks: [available("minhaempresa.com.br"), available("minhaempresa.net.br")],
      }),
    ),
    model((nextModel) => {
      expect(Array.map(nextModel.rows, (row) => row._tag)).toEqual(["Checked", "Checked"]);
    }),
  );
});

test("a submission larger than one API batch is sent as several batches", () => {
  const entries = pipe(
    Array.makeBy(60, (index) => `empresa${index}`),
    Array.join("\n"),
  );

  story(
    update,
    given(withEntries(entries)),
    message(Message.SubmittedCheckForm()),
    Command.expectExact(CheckDomains, CheckDomains),
    Command.resolveAll(
      [CheckDomains, Message.SucceededCheckDomains({ checks: [] })],
      [CheckDomains, Message.SucceededCheckDomains({ checks: [] })],
    ),
  );
});

test("an empty submission asks for an entry and checks nothing", () => {
  story(
    update,
    given(withEntries("  \n , ")),
    message(Message.SubmittedCheckForm()),
    model((nextModel) => {
      expect(nextModel.entryFeedback._tag).toBe("NoEntries");
    }),
    Command.expectNone(),
  );
});

test("rate-limited domains wait for the Registry budget and are checked again automatically", () => {
  story(
    update,
    given(withEntries("livre\nfila")),
    message(Message.SubmittedCheckForm()),
    Command.resolve(
      CheckDomains,
      Message.SucceededCheckDomains({
        checks: [available("livre.com.br"), rateLimited("fila.com.br", 2)],
      }),
    ),
    model((nextModel) => {
      expect(Array.map(nextModel.rows, (row) => row._tag)).toEqual([
        "Checked",
        "WaitingForRegistryBudget",
      ]);
    }),
    Command.resolve(
      WaitBeforeRecheck,
      Message.CompletedWaitBeforeRecheck({
        domainNames: [DomainName.make("fila.com.br")],
        retryAfterSeconds: RetryAfterSeconds.make(2),
      }),
    ),
    model((nextModel) => {
      expect(Array.map(nextModel.rows, (row) => row._tag)).toEqual(["Checked", "Checking"]);
    }),
    Command.expectExact(CheckDomains({ domainNames: [DomainName.make("fila.com.br")] })),
    Command.resolve(
      CheckDomains,
      Message.SucceededCheckDomains({ checks: [available("fila.com.br")] }),
    ),
    model((nextModel) => {
      expect(Array.map(nextModel.rows, (row) => row._tag)).toEqual(["Checked", "Checked"]);
    }),
  );
});

test("a failed request leaves its domains ready to be checked again", () => {
  story(
    update,
    given(withEntries("instavel")),
    message(Message.SubmittedCheckForm()),
    Command.resolve(
      CheckDomains,
      Message.FailedCheckDomains({ domainNames: [DomainName.make("instavel.com.br")] }),
    ),
    model((nextModel) => {
      expect(nextModel.rows).toEqual([
        DomainRow.RequestFailed({ domainName: DomainName.make("instavel.com.br") }),
      ]);
    }),
    message(Message.ClickedRecheckDomain({ domainName: DomainName.make("instavel.com.br") })),
    Command.expectExact(CheckDomains({ domainNames: [DomainName.make("instavel.com.br")] })),
    Command.resolve(
      CheckDomains,
      Message.SucceededCheckDomains({ checks: [available("instavel.com.br")] }),
    ),
  );
});

test("choosing a suggested category adds and checks it once", () => {
  const suggestion = DomainName.make("minhaempresa.net.br");

  story(
    update,
    given(emptyModel),
    message(Message.ClickedSuggestedAlternative({ domainName: suggestion })),
    Command.resolve(
      CheckDomains,
      Message.SucceededCheckDomains({ checks: [available(suggestion)] }),
    ),
    message(Message.ClickedSuggestedAlternative({ domainName: suggestion })),
    model((nextModel) => {
      expect(Array.map(nextModel.rows, (row) => [row._tag, row.domainName])).toEqual([
        ["Checked", suggestion],
      ]);
    }),
    Command.expectNone(),
  );
});
