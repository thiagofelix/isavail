import { telemetryExportVariables } from "@isavail/shared-infrastructure";
import * as Command from "alchemy/Command";
import { Effect } from "effect";
import { RELAY_TELEMETRY_SERVICE_NAME } from "./relay-telemetry.ts";

/**
 * The relay under `alchemy dev`: `src/relay-local-server.ts` on the loopback
 * interface, exporting to the shared telemetry datasets. Alchemy has no
 * local provider for Fly.io, so this replaces the App, Machine, and secrets.
 *
 * Kept out of `relay-service.ts`, the Machine's bundle entry, so the deployed
 * relay never bundles `alchemy/Command`.
 */
export const RegistryRelayLocalServer = Effect.gen(function* () {
  const telemetry = yield* telemetryExportVariables(RELAY_TELEMETRY_SERVICE_NAME);

  return yield* Command.Dev("RegistryRelayLocalServer", {
    command: "node src/relay-local-server.ts",
    env: { ...telemetry.variables, ...telemetry.secrets },
  });
});
