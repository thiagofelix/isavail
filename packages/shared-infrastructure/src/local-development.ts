import * as Alchemy from "alchemy";
import { Effect, Option } from "effect";

/**
 * True while Alchemy evaluates a Stack under `alchemy dev`.
 *
 * Inside a deployed bundle `AlchemyContext` is absent, so this is false there.
 */
export const isAlchemyDev = Effect.map(Effect.serviceOption(Alchemy.AlchemyContext), (context) =>
  Option.exists(context, ({ dev }) => dev),
);
