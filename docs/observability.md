# Observability: Axiom traces and logs per Alchemy stage

Every stage of the API Worker and the Registro.br relay sends OpenTelemetry traces and logs to Axiom.
Stage `production` writes to its own datasets. Every other stage (previews, branch or agent deploys,
and local development under `vp run dev`) writes to one shared pair of preview datasets.

## Resources

| Resource                | Axiom name                            | Retention | Lifecycle                                        |
| ----------------------- | ------------------------------------- | --------- | ------------------------------------------------ |
| Production traces       | `isavail-production-traces`           | 30 days   | Permanent; retained on destroy                   |
| Production logs         | `isavail-production-logs`             | 30 days   | Permanent; retained on destroy                   |
| Preview traces          | `isavail-preview-traces`              | 7 days    | Permanent; retained on destroy                   |
| Preview logs            | `isavail-preview-logs`                | 7 days    | Permanent; retained on destroy                   |
| Production ingest token | `isavail-production-telemetry-ingest` | —         | Can only ingest into the two production datasets |
| Preview ingest token    | `isavail-preview-telemetry-ingest`    | —         | Can only ingest into the two preview datasets    |

Definitions live in `packages/shared-infrastructure/src/axiom/telemetry-datasets.ts`.

Axiom's free Personal plan allows 3 datasets, and this needs 4. If Axiom refuses to create the
fourth one, either upgrade the plan or drop the preview logs dataset.

## Ownership and stage isolation

This is the exception to per-stage isolation that `docs/coding-standards.md` allows for shared
observability datasets.

- **Owner:** the `IsavailObservability` Stack (`packages/shared-infrastructure/alchemy.run.ts`). It
  exists only at stage `production` and refuses to run at any other stage. Its state lives in the
  same Cloudflare state store as the application Stacks.
- **Outputs:** one destination per environment (`production`, `preview`). Each output holds the OTLP
  traces and logs endpoints, plus the headers for each signal: the bearer ingest token and
  `X-Axiom-Dataset`. The headers are `Redacted` and use the `OTEL_EXPORTER_OTLP_HEADERS` format.
- **Consumers:** application Stacks read `ObservabilityStack.stage.production` through
  `telemetryExportVariables` (`@isavail/shared-infrastructure`). Stage `production` picks the
  production destination and every other stage picks the preview one. No application Stack creates
  Axiom resources, so deploying an application stage needs Cloudflare and Fly credentials only, never
  Axiom credentials.
- **Provider selection:** the Axiom resources have no local provider and are always live. Under
  `alchemy dev` both apps export to the preview datasets.

## Ordering

1. `vp run deploy:observability` creates or updates the datasets and tokens. This step needs Axiom
   credentials (`alchemy profile`), and it has to run once before any application stage is deployed
   or run with `vp run dev`. Until then, application Stacks fail with
   `Reference to stack 'IsavailObservability' at stage 'production' not found`.
2. Next, deploy the application Stacks. `@isavail/relay#deploy:production` depends on
   `@isavail/shared-infrastructure#deploy`, so `vp run deploy:production` deploys observability
   first. Preview deploys don't redeploy it.
3. Destroying an application stage never touches the observability Stack. Destroying the
   observability Stack (`vp run @isavail/shared-infrastructure#destroy`) deletes both tokens, which
   stops every stage from exporting, but keeps all four datasets.

Rotating a token means replacing it in the observability Stack. Application stages pick up the new
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

The API Worker's `http.server` span covers each `/v1` request. Its `RegistryRelayClient` uses
Effect's `HttpClient`, which sends a W3C `traceparent` header. The relay's router continues that
context in its own `http.server` span. The relay's lookup spans (`RelayAuthorization.bearer` and the
ISAVAIL client) therefore appear in the same trace as the Worker request that caused them.

## Querying

Select one stage of the shared preview dataset by its resource attribute:

```apl
['isavail-preview-traces']
| where ['resource.custom']['alchemy.stage'] == "pr-42"
| summarize count() by ['service.name'], name
```

A failing request is traced end to end by its trace ID:

```apl
['isavail-production-traces']
| where trace_id == "<trace-id>"
| sort by _time asc
| project _time, ['service.name'], name, duration, status.code
```

The field path for custom resource attributes (`['resource.custom'][…]`) follows Axiom's documented
OpenTelemetry mapping. It hasn't been checked against ingested spans yet.

## Still unverified (needs a deployed stage)

- That Axiom accepts the fourth dataset on the current plan.
- That the relay's `http.server` span is parented to the Worker's client span in Axiom, i.e. that
  `traceparent` survives the Fly proxy.
- That two `alchemy dev` processes (relay and web) run side by side under `vp run dev` without
  contending for the dev sidecar.
- The field paths for resource and span attributes in Axiom.
