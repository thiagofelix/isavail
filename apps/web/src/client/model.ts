import { DomainAvailability, DomainName, RetryAfterSeconds } from "@isavail/availability-contract";
import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";
import { DomainCheckFailure } from "../api/availability-http-api.ts";

/** Where one requested domain stands. */
export const DomainRow = defineTaggedUnion({
  Checking: { domainName: DomainName },
  Checked: {
    domainName: DomainName,
    availability: DomainAvailability,
    checkedAt: Schema.DateTimeUtcFromString,
    servedFromCache: Schema.Boolean,
  },
  WaitingForRegistryBudget: { domainName: DomainName, retryAfterSeconds: RetryAfterSeconds },
  NotChecked: { domainName: DomainName, failure: DomainCheckFailure },
  RequestFailed: { domainName: DomainName },
});

/** Where one requested domain stands. */
export type DomainRow = typeof DomainRow.Type;

/** What the form says about the entries the person submitted. */
export const EntryFeedback = defineTaggedUnion({
  Accepted: {},
  NoEntries: {},
  TooManyEntries: { count: Schema.Number },
  RejectedEntries: { entries: Schema.Array(Schema.String) },
});

/** What the form says about the entries the person submitted. */
export type EntryFeedback = typeof EntryFeedback.Type;

/** The whole page state. */
export const Model = Schema.Struct({
  entriesInput: Schema.String,
  entryFeedback: EntryFeedback,
  rows: Schema.Array(DomainRow),
});

/** The whole page state. */
export type Model = typeof Model.Type;
