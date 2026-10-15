/**
 * Writes the public API's OpenAPI document to `openapi.json`. The document is
 * generated from `AvailabilityHttpApi`; never edit the JSON by hand.
 */
import { writeFileSync } from "node:fs";
import { OpenApi } from "effect/http-api";
import { AvailabilityHttpApi } from "../src/api/availability-http-api.ts";

const OUTPUT_PATH = new URL("../openapi.json", import.meta.url);

writeFileSync(OUTPUT_PATH, `${JSON.stringify(OpenApi.fromApi(AvailabilityHttpApi), null, 2)}\n`);
