import { DomainName } from "../domain/domain-name.ts";
import { RetryAfterSeconds } from "../registry/registry-lookup.ts";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { DomainCheck } from "../api/availability-http-api.ts";

/** Everything that can happen on the page. */
export const Message = defineMessageUnion({
  UpdatedEntriesInput: { value: Schema.String },
  SubmittedCheckForm: {},
  SucceededCheckDomains: { checks: Schema.Array(DomainCheck) },
  FailedCheckDomains: { domainNames: Schema.Array(DomainName) },
  CompletedWaitBeforeRecheck: {
    domainNames: Schema.Array(DomainName),
    retryAfterSeconds: RetryAfterSeconds,
  },
  ClickedRecheckDomain: { domainName: DomainName },
  ClickedSuggestedAlternative: { domainName: DomainName },
});

/** Everything that can happen on the page. */
export type Message = typeof Message.Type;
