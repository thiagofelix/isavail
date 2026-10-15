import {
  LOCAL_REGISTRY_RELAY_ACCESS_TOKEN,
  LOCAL_REGISTRY_RELAY_URL,
  REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE,
} from "@isavail/availability-contract";
import { RegistryRelayStack } from "@isavail/availability-contract/relay-stack";
import { isAlchemyDev } from "@isavail/shared-infrastructure";
import { Effect } from "effect";
import { REGISTRY_RELAY_URL_VARIABLE } from "./registry-relay-client.ts";

/**
 * Worker bindings that tell the API Worker where the relay is.
 *
 * A deployed stage reads the outputs of the relay Stack of the same stage.
 * Under `alchemy dev` it points at the relay the developer runs locally,
 * because Fly.io has no Alchemy local provider; see `docs/architecture.md`.
 *
 * This runs inside the deployed Worker bundle too, where it must not touch
 * deployment state: `AlchemyContext` is absent there, and a Stack reference is
 * only a description of outputs until Alchemy resolves it.
 */
export const registryRelayWorkerEnv = Effect.gen(function* () {
  if (yield* isAlchemyDev) {
    return {
      [REGISTRY_RELAY_URL_VARIABLE]: LOCAL_REGISTRY_RELAY_URL,
      [REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE]: LOCAL_REGISTRY_RELAY_ACCESS_TOKEN,
    };
  }

  const relay = yield* RegistryRelayStack;

  return {
    [REGISTRY_RELAY_URL_VARIABLE]: relay.url,
    [REGISTRY_RELAY_ACCESS_TOKEN_VARIABLE]: relay.accessToken,
  };
});
