import { ConfigProvider, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

/**
 * OpenTelemetry settings that apply unless the environment overrides them.
 *
 * The OpenTelemetry specification makes `otlp` the default exporter for every
 * signal, but Effect exports a signal only when its `OTEL_*_EXPORTER` variable
 * names `otlp`. Defaulting them here means setting
 * `OTEL_EXPORTER_OTLP_ENDPOINT` alone turns on traces, logs, and metrics.
 * Without an endpoint nothing is exported, and `OTEL_SDK_DISABLED=true` turns
 * every exporter off.
 */
const OPENTELEMETRY_DEFAULTS = {
  OTEL_SERVICE_NAME: "isavail",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
};

const openTelemetryConfig = ConfigProvider.fromEnv().pipe(
  ConfigProvider.orElse(ConfigProvider.fromUnknown(OPENTELEMETRY_DEFAULTS)),
);

/**
 * Exports traces, logs, and metrics over OTLP/HTTP (protobuf) to the collector
 * the standard `OTEL_EXPORTER_OTLP_*` variables name, with the resource the
 * `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` variables describe.
 *
 * Logs still go to standard output as well; the OTLP logger is added beside
 * the console logger. Exports are batched on an interval and flushed when the
 * process shuts down.
 */
export const telemetryLayer = Otlp.layerFromConfig().pipe(
  Layer.provide(OtlpSerialization.layerProtobuf),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigProvider.layer(openTelemetryConfig)),
);
