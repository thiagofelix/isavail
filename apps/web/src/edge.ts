/**
 * Website entry: forwards the public API (`/v1/*`) to the availability API
 * Worker through its service binding and serves everything else from the
 * Foldkit build. Browsers and Agents therefore reach the API on the website's
 * own origin, with no cross-origin requests.
 */
import type { WebsiteEnv } from "../alchemy.run.ts";

const API_PATH_PREFIX = "/v1/";

/**
 * Sends `/v1/*` to the availability API Worker and every other path to the static assets.
 *
 * @internal
 */
export default {
  fetch(request: Request, env: WebsiteEnv): Promise<Response> {
    return new URL(request.url).pathname.startsWith(API_PATH_PREFIX)
      ? env.AVAILABILITY_API.fetch(request)
      : env.ASSETS.fetch(request);
  },
};
