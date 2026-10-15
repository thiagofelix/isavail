import * as Alchemy from "alchemy";
import type { Redacted } from "effect";

/** Outputs the Registro.br relay Stack publishes for the web app Stack. */
export interface RegistryRelayStackOutputs {
  /** Public HTTPS base URL of the relay, without a trailing slash. */
  readonly url: string;
  /** Bearer token the relay requires on lookup requests. */
  readonly accessToken: Redacted.Redacted<string>;
}

/**
 * Reference to the Registro.br relay Stack.
 *
 * The relay app provisions it with `RegistryRelayStack.make(...)`; the web app
 * yields it to read the relay outputs of the same stage. The relay Stack owns
 * its Fly.io App, Machine, and access token, and must be deployed before the
 * web app Stack of the same stage and destroyed after it.
 */
export class RegistryRelayStack extends Alchemy.Stack<
  RegistryRelayStack,
  RegistryRelayStackOutputs
>()("IsavailRegistryRelay") {}
