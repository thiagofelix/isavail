/**
 * Runs isavail as one Node process: the website, the public API under `/v1`,
 * and the Registro.br ISAVAIL client it asks, with answers cached in SQLite.
 *
 * Configuration comes from the environment:
 *
 * - `ISAVAIL_HOST` and `ISAVAIL_PORT`: where to listen (default `127.0.0.1:4310`).
 * - `ISAVAIL_DATABASE`: the SQLite cache file (default `isavail.sqlite`).
 * - `ISAVAIL_WEBSITE_DIR`: the built website (default `../client` beside this file).
 * - `OTEL_*`: OpenTelemetry export; see `telemetry.ts`.
 */
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, Path } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.layerConfig takes node:http's createServer.
import { createServer } from "node:http";
import { availabilityHttpApiLayer } from "../api/availability-http-handlers.ts";
import { telemetryLayer } from "./telemetry.ts";

/** Vite fingerprints every file under `assets/`, so a browser may keep them forever. */
const FINGERPRINTED_ASSETS_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** `index.html` names the current assets, so a browser revalidates it on every visit. */
const WEBSITE_CACHE_CONTROL = "no-cache";

const listenConfig = {
  host: Config.String("ISAVAIL_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("ISAVAIL_PORT").pipe(Config.withDefault(4310)),
};

/**
 * The directory the website was built into. The production build places this
 * program at `dist/server/main.js` and the website at `dist/client`.
 */
const websiteDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const besideServer = yield* path.fromFileUrl(new URL("../client", import.meta.url));

  return yield* Config.String("ISAVAIL_WEBSITE_DIR").pipe(Config.withDefault(besideServer));
});

/**
 * Serves the built website, falling back to `index.html` for any other path so
 * the single-page app can route itself. Without a build (for example under
 * `vp run dev`, where Vite serves the website) only the API is served.
 */
const websiteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* websiteDirectory;

    if (!(yield* fileSystem.exists(path.join(root, "index.html")))) {
      yield* Effect.logWarning("No website build found; serving the API only", root);

      return Layer.empty;
    }

    yield* Effect.logInfo("Serving the website", root);

    return Layer.mergeAll(
      HttpStaticServer.layer({
        root: path.join(root, "assets"),
        prefix: "/assets",
        cacheControl: FINGERPRINTED_ASSETS_CACHE_CONTROL,
      }),
      HttpStaticServer.layer({ root, spa: true, cacheControl: WEBSITE_CACHE_CONTROL }),
    );
  }),
);

/** Answers unknown `/v1` paths with 404 instead of the website's `index.html`. */
const unknownApiPathLayer = HttpRouter.add("*", "/v1/*", HttpServerResponse.empty({ status: 404 }));

const serverLayer = HttpRouter.serve(
  Layer.mergeAll(availabilityHttpApiLayer, unknownApiPathLayer, websiteLayer),
).pipe(Layer.provide(NodeHttpServer.layerConfig(createServer, listenConfig)));

Layer.launch(serverLayer).pipe(Effect.provide(telemetryLayer), NodeRuntime.runMain);
