# Observability

isavail writes logs to standard output (the systemd journal under the NixOS module). It can also
send traces, logs, and metrics to any OpenTelemetry collector over OTLP/HTTP with protobuf
encoding. Nothing is exported until a collector endpoint is configured.

## Turning export on

Set the standard OpenTelemetry variables. `src/server/telemetry.ts` installs Effect's
`Otlp.layerFromConfig`, which reads them once at startup.

| Variable                                                                               | Default   | Notes                                                                                                                                  |
| -------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                          | unset     | Base URL of the collector's OTLP/HTTP receiver, usually port 4318. Signals go to `/v1/traces`, `/v1/logs`, and `/v1/metrics` under it. |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT`                                    | unset     | Full per-signal URLs; each overrides the base endpoint for its signal.                                                                 |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_HEADERS`       | unset     | `key=value,key2=value2`, percent-encoded. Use for collector authentication.                                                            |
| `OTEL_SERVICE_NAME`                                                                    | `isavail` | `service.name` of every signal.                                                                                                        |
| `OTEL_RESOURCE_ATTRIBUTES`                                                             | unset     | Extra resource attributes, for example `deployment.environment.name=homelab`.                                                          |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`                  | `otlp`    | Set one to `none` to stop exporting that signal.                                                                                       |
| `OTEL_SDK_DISABLED`                                                                    | `false`   | `true` turns every exporter off.                                                                                                       |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_EXPORTER_OTLP_TIMEOUT` | Effect's  | Batching interval and timeouts, in milliseconds.                                                                                       |

Only OTLP over HTTP is supported, not gRPC (port 4317). Point the endpoint at the collector's
`otlphttp` receiver.

Effect exports a signal only when its `OTEL_*_EXPORTER` variable names `otlp`, even though the
OpenTelemetry specification makes `otlp` the default. `telemetry.ts` supplies those defaults (and
`OTEL_SERVICE_NAME=isavail`), so setting `OTEL_EXPORTER_OTLP_ENDPOINT` alone is enough. Variables
in the environment always win over these defaults.

With the NixOS module:

```nix
services.isavail.openTelemetry = {
  endpoint = "http://otel-collector.home.arpa:4318";
  resourceAttributes."deployment.environment.name" = "homelab";
};
# Collector credentials stay out of the Nix store:
services.isavail.environmentFile = "/run/secrets/isavail.env"; # OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20…
```

Exports are batched on an interval and flushed when the process stops, including on the SIGTERM
systemd sends.

## What is emitted

- **Traces.** Each HTTP request gets an `http.server` span from Effect's HTTP server, with
  `http.route` and the response status. Inside it are `AvailabilityHttpApi.checkRequestedDomains`
  (attribute `request.id`, the public `requestId`), `AvailabilityChecker.checkDomains`
  (`availability.domain_count`, `availability.cached_count`), `AvailabilityCache.*`, and
  `IsavailClient.lookUpDomains` (`isavail.domain_count`), plus SQL spans from the SQLite client.
  The time Registro.br takes is the duration of `IsavailClient.lookUpDomains`.
- **Logs.** Every `Effect.log*` record, including one per HTTP response and the warnings for
  unreadable ISAVAIL datagrams, Registro.br refusals, and cache failures. Log records carry the
  trace and span IDs of the request they belong to.
- **Metrics.** Whatever Effect's runtime records through its `Metric` module. The app defines no
  custom metrics yet.

## Finding one request

The `requestId` in every API response (`req_…`) is the `request.id` attribute of the request's
`AvailabilityHttpApi.checkRequestedDomains` span. Search for that attribute in the trace backend to
find the whole trace.
