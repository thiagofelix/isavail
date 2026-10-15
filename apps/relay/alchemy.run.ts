/**
 * Registro.br relay Stack.
 *
 * Owns, per stage: the relay Fly App, Machine, public address, access token,
 * and the Fly secrets that carry its telemetry ingest headers. The web app
 * Stack of the same stage reads `url` and `accessToken` through
 * `RegistryRelayStack`, so this Stack is deployed first and destroyed last.
 * State lives in the Cloudflare state store both Stacks share, which is what
 * lets the web Stack resolve these outputs.
 *
 * Traces and logs go to the Axiom destination of the stage, read from the
 * observability Stack (`@isavail/shared-infrastructure`), which must have been
 * deployed once before.
 *
 * Fly.io has no Alchemy local provider. Under `alchemy dev` this Stack
 * therefore declares no Fly resources and runs `src/relay-local-server.ts`
 * locally instead; see `docs/architecture.md`.
 */
import {
  LOCAL_REGISTRY_RELAY_ACCESS_TOKEN,
  LOCAL_REGISTRY_RELAY_URL,
} from "@isavail/availability-contract";
import { RegistryRelayStack } from "@isavail/availability-contract/relay-stack";
import { isAlchemyDev } from "@isavail/shared-infrastructure";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Fly from "alchemy/Fly";
import { Effect, Layer } from "effect";
import { RegistryRelayLocalServer } from "./src/relay-local-development.ts";
import RegistryRelayService, {
  RegistryRelayAccessToken,
  RegistryRelayApp,
  RegistryRelayPublicAddress,
} from "./src/relay-service.ts";

export default RegistryRelayStack.make(
  {
    providers: Layer.mergeAll(Fly.providers(), Alchemy.RandomProvider(), Command.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    if (yield* isAlchemyDev) {
      yield* RegistryRelayLocalServer;

      return {
        url: LOCAL_REGISTRY_RELAY_URL,
        accessToken: LOCAL_REGISTRY_RELAY_ACCESS_TOKEN,
      };
    }

    const app = yield* RegistryRelayApp;
    const accessToken = yield* RegistryRelayAccessToken;

    yield* RegistryRelayPublicAddress;
    yield* RegistryRelayService;

    return {
      url: app.url,
      accessToken: accessToken.text,
    };
  }),
);
