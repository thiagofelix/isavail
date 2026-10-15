import { DomainName } from "../domain/domain-name.ts";
import { RetryAfterSeconds } from "../registry/registry-lookup.ts";
import { Duration, Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { Command } from "foldkit";
import { AvailabilityHttpApi } from "../api/availability-http-api.ts";
import { Message } from "./message.ts";

/**
 * Asks the availability API about up to one batch of domains.
 *
 * @internal
 */
export const CheckDomains = Command.define("CheckDomains", {
  args: { domainNames: Schema.Array(DomainName) },
  messages: [Message.SucceededCheckDomains, Message.FailedCheckDomains],
  execute: ({ domainNames }) =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(AvailabilityHttpApi, {
        baseUrl: globalThis.location.origin,
      });
      const report = yield* client.domainAvailability.checkDomains({
        payload: { domains: domainNames },
      });

      return Message.SucceededCheckDomains({ checks: report.checks });
    }).pipe(Effect.orElseSucceed(() => Message.FailedCheckDomains({ domainNames }))),
});

/** Waits until Registro.br's query budget allows the domains to be asked about again. */
export const WaitBeforeRecheck = Command.define("WaitBeforeRecheck", {
  args: { domainNames: Schema.Array(DomainName), retryAfterSeconds: RetryAfterSeconds },
  messages: [Message.CompletedWaitBeforeRecheck],
  execute: ({ domainNames, retryAfterSeconds }) =>
    Effect.sleep(Duration.seconds(retryAfterSeconds)).pipe(
      Effect.as(Message.CompletedWaitBeforeRecheck({ domainNames, retryAfterSeconds })),
    ),
});
