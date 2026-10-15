# Observability: Axiom traces and logs per Alchemy stage

Every stage of the API Worker and the Registro.br relay sends OpenTelemetry traces and logs to Axiom.
All stages (production, previews, branch or agent deploys, and local development under `vp run dev`)
share one traces dataset and one logs dataset. The `alchemy.stage` resource attribute on every span
and log record tells stages apart.

## Resources

| Resource     | Axiom name                 | Retention | Lifecycle                             |
| ------------ | -------------------------- | --------- | ------------------------------------- |
| Traces       | `isavail-traces`           | 30 days   | Permanent; retained on destroy        |
| Logs         | `isavail-logs`             | 30 days   | Permanent; retained on destroy        |
| Ingest token | `isavail-telemetry-ingest` | —         | Can only ingest into the two datasets |
| Dashboard    | `isavail traces`           | —         | Deleted on destroy                    |

Definitions live in `packages/shared-infrastructure/src/axiom/telemetry-datasets.ts`. Traces and
logs can't share a dataset, because a dataset's kind (`otel:traces:v1`, `otel:logs:v1`) fixes the one
signal it accepts. 30 days is the most retention Axiom's free Personal plan allows.

## Ownership and stage isolation

This is the exception to per-stage isolation that `docs/coding-standards.md` allows for shared
observability datasets.

- **Owner:** the `IsavailObservability` Stack (`packages/shared-infrastructure/alchemy.run.ts`). It
  exists only at stage `production` and refuses to run at any other stage. Its state lives in the
  same Cloudflare state store as the application Stacks.
- **Outputs:** the OTLP traces and logs endpoints, plus the headers for each signal: the bearer
  ingest token and `X-Axiom-Dataset`. The headers are `Redacted` and use the `OTEL_EXPORTER_OTLP_HEADERS` format.
- **Consumers:** application Stacks read `ObservabilityStack.stage.production` through
  `telemetryExportVariables` (`@isavail/shared-infrastructure`), which also sets the
  `alchemy.stack` and `alchemy.stage` resource attributes. No application Stack creates
  Axiom resources, so deploying an application stage needs Cloudflare and Fly credentials only, never
  Axiom credentials.
- **Provider selection:** the Axiom resources have no local provider and are always live. Under
  `alchemy dev` both apps export to the same datasets, under their `dev_<user>` stage.

## Ordering

1. `vp run deploy:observability` creates or updates the datasets and the token. This step needs Axiom
   credentials (`alchemy profile`), and it has to run once before any application stage is deployed
   or run with `vp run dev`. Until then, application Stacks fail with
   `Reference to stack 'IsavailObservability' at stage 'production' not found`.
2. Next, deploy the application Stacks. `@isavail/relay#deploy:production` depends on
   `@isavail/shared-infrastructure#deploy`, so `vp run deploy:production` deploys observability
   first. Preview deploys don't redeploy it.
3. Destroying an application stage never touches the observability Stack. Destroying the
   observability Stack (`vp run @isavail/shared-infrastructure#destroy`) deletes the token, which
   stops every stage from exporting, but keeps both datasets.

Rotating the token means replacing it in the observability Stack. Application stages pick up the new
headers on their next deploy (Workers: secret bindings; relay: Fly secrets, whose digests are in the
Machine config so the Machine restarts with them).

## How each runtime exports

Both apps are configured through the standard OpenTelemetry variables that `telemetryExportVariables`
returns:

| Variable                                                                 | Value                                                 | Bound as |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | -------- |
| `OTEL_SERVICE_NAME`                                                      | `isavail-availability-api` / `isavail-registry-relay` | plain    |
| `OTEL_RESOURCE_ATTRIBUTES`                                               | `alchemy.stack=<Stack>,alchemy.stage=<stage>`         | plain    |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`                             | `otlp`                                                | plain    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Axiom OTLP endpoints                                  | plain    |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS`   | bearer token and dataset                              | secret   |

- **`AvailabilityApi` Worker** (`apps/web/src/api/availability-api-worker.ts`): the variables are
  Worker bindings, and the headers are `secret_text`. Alchemy's Worker runtime builds an OTLP
  exporter for each request from these bindings and flushes it in `waitUntil` after the response, so
  exporting never delays a response. Alchemy also adds the `alchemy.stack` and `alchemy.stage`
  resource attributes. The `Website` Worker is a plain asset/forwarding entry and exports nothing.
- **Relay on Fly.io** (`apps/relay/src/relay-telemetry.ts`): Fly.Services don't get Alchemy's
  exporter, so the relay installs Effect's `OtlpTracer.layerFromConfig` and
  `OtlpLogger.layerFromConfig` once per process. They batch on an interval and flush on graceful
  shutdown. The endpoints are Machine `env`. The header variables are Fly secrets
  (`RegistryRelayTracesHeadersSecret`, `RegistryRelayLogsHeadersSecret`), because Fly stores Machine
  `env` in plain text.
- **Relay under `alchemy dev`** (`apps/relay/src/relay-local-development.ts`): the relay Stack runs
  `src/relay-local-server.ts` with `Command.Dev` and the same variables, so the local relay exports
  exactly like the deployed one.

### Connected traces

Each `/v1` request gets an `http.server` span in the API Worker (span name: the HTTP method, with
`http.route` as an attribute). The Worker's `RegistryRelayClient` uses Effect's `HttpClient`, which
sends a W3C `traceparent` header. The relay continues that context in its own `http.server` span, so
the relay's lookup spans (`RelayAuthorization.bearer` and `IsavailClient.lookUpDomains`) appear in the
same trace as the Worker request that caused them.

The relay applies `HttpMiddleware.tracer` itself (`apps/relay/src/relay-telemetry.ts`). Effect's
HTTP server traces a request only when the server's own fiber has a tracer. The server fiber belongs
to Alchemy's Fly runtime or to `relay-local-server.ts`, and neither installs an exporter. Without the
middleware, the relay sent no server span and each lookup started a trace of its own.

## Dashboard

The `isavail traces` dashboard (`packages/shared-infrastructure/src/axiom/traces-dashboard.ts`) is
created by the observability Stack. Its filter bar selects a stage (the options come from the stages
seen in the dataset) and a service. Every chart applies both filters.

| Row | Charts                                                                                    |
| --- | ----------------------------------------------------------------------------------------- |
| 1   | Requests, failed requests (%), request p95 (ms), answers served from cache (%)            |
| 2   | Requests by service; request latency p50/p95/p99                                          |
| 3   | Responses by status class; Registro.br lookup p95 (Worker → relay vs relay → Registro.br) |
| 4   | Domains checked, fresh vs cached; slowest operations                                      |
| 5   | Routes: requests, failures, and latency per service, method, and route                    |
| 6   | Recent errors with stage, span, status message, and example trace IDs                     |

Request charts leave out `/v1/health`, and the Routes table still lists it. The domain charts read
span names and attributes set in the apps, as the module's comment lists. Renaming one of them
empties its chart, so update the dashboard in the same change.

The queries use Axiom's OpenTelemetry fields (`kind`, `duration`, `status.code`, `service.name`,
`attributes.http.route`, `attributes.http.response.status_code`, `['resource.custom'][…]`,
`['attributes.custom'][…]`). They were checked against ingested isavail spans and Axiom's
`otel-demo-traces`. Axiom adds a column only once a span carries it, so the queries read the status
columns through `column_ifexists`.

## Querying

Select one stage by its resource attribute:

```apl
['isavail-traces']
| where ['resource.custom']['alchemy.stage'] == "pr-42"
| summarize count() by ['service.name'], name
```

Follow one request end to end by its trace ID:

```apl
['isavail-traces']
| where trace_id == "<trace-id>"
| sort by _time asc
| project _time, ['service.name'], name, duration, ['status.code']
```

## Still unverified (needs a deployed stage)

- That `traceparent` survives the Fly proxy, so the deployed relay's spans join the Worker's trace.
  Locally, the relay's `http.server` span continues the caller's trace (checked against a local OTLP
  collector).
- That two `alchemy dev` processes (relay and web) run side by side under `vp run dev` without
  contending for the dev sidecar.
