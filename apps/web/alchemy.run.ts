/**
 * Web app Stack: the Foldkit website, the public availability API Worker, and
 * the KV namespace that remembers recent Registro.br answers.
 *
 * A deployed stage reads the relay URL and access token from the
 * `IsavailRegistryRelay` Stack of the same stage, which must be deployed first
 * and destroyed after this Stack. Under `alchemy dev` the Worker and KV run
 * locally in workerd and the API Worker calls the relay the developer runs with
 * `vp run @isavail/relay#dev`; see `docs/architecture.md`.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import AvailabilityApiWorker from "./src/api/availability-api-worker.ts";
import { AvailabilityCacheNamespace } from "./src/api/availability-cache.ts";

/** The Foldkit website. `/v1/*` runs its Worker entry, which forwards to the API Worker. */
export class Website extends Cloudflare.Website.Foldkit<Website>()("Website", {
  main: "src/edge.ts",
  env: { AVAILABILITY_API: AvailabilityApiWorker },
  assets: { runWorkerFirst: ["/v1/*"] },
  dev: { host: "127.0.0.1", port: 5180, strictPort: true },
}) {}

/** Bindings the website's Worker entry receives. */
export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export default Alchemy.Stack(
  "IsavailWeb",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    yield* AvailabilityCacheNamespace;
    const api = yield* AvailabilityApiWorker;
    const website = yield* Website;

    return {
      url: website.url,
      apiUrl: api.url,
    };
  }),
);
