/**
 * Writes the public API's OpenAPI document to `openapi.json`. The document is
 * generated from `AvailabilityHttpApi`; never edit the JSON by hand.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { AvailabilityHttpApi } from "../src/api/availability-http-api.ts";

const OpenApiDocumentJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });

const writeOpenApiDocument = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputPath = yield* path.fromFileUrl(new URL("../openapi.json", import.meta.url));

  const document = yield* Schema.encodeEffect(OpenApiDocumentJson)(
    OpenApi.fromApi(AvailabilityHttpApi),
  );

  yield* fileSystem.writeFileString(outputPath, `${document}\n`);
});

writeOpenApiDocument.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
