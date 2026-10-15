import {
  type DomainName,
  DomainNameFromInput,
  type RetryAfterSeconds,
} from "@isavail/availability-contract";
import { Array, Option, pipe, Schema, String } from "effect";
import type { Runtime, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { DomainCheck, MAX_DOMAIN_CHECK_BATCH_SIZE } from "../api/availability-http-api.ts";
import { CheckDomains, WaitBeforeRecheck } from "./command.ts";
import { Message } from "./message.ts";
import { DomainRow, EntryFeedback, type Model } from "./model.ts";

/** Most entries one submission may contain. */
export const MAX_ENTRIES_PER_SUBMISSION = 100;

const ENTRY_SEPARATOR = /[\n,;]+/;

const decodeEntry = Schema.decodeOption(DomainNameFromInput);

const splitEntries = (entriesInput: string): Array<string> =>
  pipe(
    entriesInput.split(ENTRY_SEPARATOR),
    Array.map(String.trim),
    Array.filter(String.isNonEmpty),
  );

const checkCommandsFor = (domainNames: ReadonlyArray<DomainName>) =>
  pipe(
    domainNames,
    Array.chunksOf(MAX_DOMAIN_CHECK_BATCH_SIZE),
    Array.map((batch) => CheckDomains({ domainNames: batch })),
  );

const rowFromCheck = (check: DomainCheck): DomainRow =>
  DomainCheck.match<DomainRow>(check, {
    Checked: ({ domainName, availability, checkedAt, servedFromCache }) =>
      DomainRow.Checked({ domainName, availability, checkedAt, servedFromCache }),
    NotChecked: ({ domainName, failure }) => {
      if (failure._tag === "RegistryRateLimited") {
        return DomainRow.WaitingForRegistryBudget({
          domainName,
          retryAfterSeconds: failure.retryAfterSeconds,
        });
      } else {
        return DomainRow.NotChecked({ domainName, failure });
      }
    },
  });

const waitCommandsFor = (rows: ReadonlyArray<DomainRow>) => {
  const waitingRows = Array.filter(rows, DomainRow.isAnyOf(["WaitingForRegistryBudget"]));
  const delays = pipe(
    waitingRows,
    Array.map(({ retryAfterSeconds }) => retryAfterSeconds),
    Array.dedupe,
  );

  return Array.map(delays, (retryAfterSeconds) =>
    WaitBeforeRecheck({
      retryAfterSeconds,
      domainNames: pipe(
        waitingRows,
        Array.filter((row) => row.retryAfterSeconds === retryAfterSeconds),
        Array.map(({ domainName }) => domainName),
      ),
    }),
  );
};

const replaceRows = (
  rows: ReadonlyArray<DomainRow>,
  domainNames: ReadonlyArray<DomainName>,
  toRow: (row: DomainRow) => DomainRow,
): Array<DomainRow> =>
  Array.map(rows, (row) => (Array.contains(domainNames, row.domainName) ? toRow(row) : row));

const markChecking = (row: DomainRow): DomainRow =>
  DomainRow.Checking({ domainName: row.domainName });

const isWaitingFor =
  (retryAfterSeconds: RetryAfterSeconds) =>
  (row: DomainRow): boolean =>
    row._tag === "WaitingForRegistryBudget" && row.retryAfterSeconds === retryAfterSeconds;

/** Advances the page for each Message. */
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedEntriesInput: ({ value }) => ({
      model: modifyFields(model, { entriesInput: () => value }),
    }),

    SubmittedCheckForm: () => {
      const entries = splitEntries(model.entriesInput);

      if (Array.isArrayEmpty(entries)) {
        return { model: modifyFields(model, { entryFeedback: () => EntryFeedback.NoEntries() }) };
      } else if (entries.length > MAX_ENTRIES_PER_SUBMISSION) {
        return {
          model: modifyFields(model, {
            entryFeedback: () => EntryFeedback.TooManyEntries({ count: entries.length }),
          }),
        };
      }

      const decodedEntries = Array.map(entries, (entry) => ({
        entry,
        maybeDomain: decodeEntry(entry),
      }));
      const rejectedEntries = pipe(
        decodedEntries,
        Array.filter(({ maybeDomain }) => Option.isNone(maybeDomain)),
        Array.map(({ entry }) => entry),
      );
      const domainNames = pipe(
        decodedEntries,
        Array.map(({ maybeDomain }) => maybeDomain),
        Array.getSomes,
        Array.dedupe,
      );

      return {
        model: modifyFields(model, {
          entryFeedback: () =>
            Array.isArrayEmpty(rejectedEntries)
              ? EntryFeedback.Accepted()
              : EntryFeedback.RejectedEntries({ entries: rejectedEntries }),
          rows: () => Array.map(domainNames, (domainName) => DomainRow.Checking({ domainName })),
        }),
        commands: checkCommandsFor(domainNames),
      };
    },

    SucceededCheckDomains: ({ checks }) => {
      const checkedRows = Array.map(checks, rowFromCheck);
      const nextRows = Array.map(model.rows, (row) =>
        Option.getOrElse(
          Array.findFirst(checkedRows, (checkedRow) => checkedRow.domainName === row.domainName),
          () => row,
        ),
      );

      return {
        model: modifyFields(model, { rows: () => nextRows }),
        commands: waitCommandsFor(checkedRows),
      };
    },

    FailedCheckDomains: ({ domainNames }) => ({
      model: modifyFields(model, {
        rows: (rows) =>
          replaceRows(rows, domainNames, (row) =>
            row._tag === "Checking" ? DomainRow.RequestFailed({ domainName: row.domainName }) : row,
          ),
      }),
    }),

    CompletedWaitBeforeRecheck: ({ domainNames, retryAfterSeconds }) => {
      const stillWaiting = pipe(
        model.rows,
        Array.filter(isWaitingFor(retryAfterSeconds)),
        Array.map(({ domainName }) => domainName),
        Array.filter((domainName) => Array.contains(domainNames, domainName)),
      );

      return {
        model: modifyFields(model, {
          rows: (rows) => replaceRows(rows, stillWaiting, markChecking),
        }),
        commands: checkCommandsFor(stillWaiting),
      };
    },

    ClickedRecheckDomain: ({ domainName }) => ({
      model: modifyFields(model, {
        rows: (rows) => replaceRows(rows, [domainName], markChecking),
      }),
      commands: [CheckDomains({ domainNames: [domainName] })],
    }),

    ClickedSuggestedAlternative: ({ domainName }) => {
      if (Array.some(model.rows, (row) => row.domainName === domainName)) {
        return { model };
      }

      return {
        model: modifyFields(model, {
          rows: (rows) => Array.append(rows, DomainRow.Checking({ domainName })),
        }),
        commands: [CheckDomains({ domainNames: [domainName] })],
      };
    },
  });

/** Starts with an empty form and no results. */
export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    entriesInput: "",
    entryFeedback: EntryFeedback.Accepted(),
    rows: [],
  },
});
