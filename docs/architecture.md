# Architecture

isavail checks whether `.br` domains can be registered, for people choosing a company name and
for AI agents generating them. Every answer comes from Registro.br's official ISAVAIL
availability service.

```text
browser / Agent
   │  HTTPS, same origin
   ▼
Website Worker (Cloudflare) ── /v1/* ──▶ AvailabilityApi Worker (Cloudflare) ──▶ Workers KV cache
   │  Foldkit SPA assets                       │  HTTPS + bearer token
   ▼                                           ▼
                                     Registro.br relay (Fly.io, gru)
                                               │  UDP 43, ISAVAIL protocol
                                               ▼
                                     avail.registro.br
```

## Why a relay outside Cloudflare

ISAVAIL is UDP only: `avail.registro.br` refuses TCP on port 43. Cloudflare Workers can open TCP
sockets but not UDP ones, so the Workers cannot speak to Registro.br themselves. The relay is a
small Effect program on one Fly.io Machine in São Paulo (`gru`) that turns HTTP lookups into
ISAVAIL datagrams.

One Machine is deliberate. Registro.br issues its cookie and its query budget per source address,
and the relay paces itself with a process-local rate limiter. More Machines would need a shared
store such as `RateLimiter.layerStoreRedis`, and a fixed egress address would be needed before
Registro.br could register the relay as a proxy (the protocol's `[ip]` field).

## Registro.br behavior the relay depends on

Measured against the live service on 2026-10-15. The published specification in
`Protocolo-ISAVAIL.txt` differs from the live service in several places; the relay follows the
live service.

| Behavior                                                                                                                                                             | Consequence in code                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each source address gets a token bucket of 30 queries that refills at one query per second. An empty bucket turns every query into `ST 8 Query rate limit exceeded`. | `IsavailClientSettings`: burst 25, refill one per 1.2 s, an adaptive cooldown after a refusal, and a 5 s pacing budget per request. Domains beyond the budget are `RegistryRateLimited` with `retryAfterSeconds`; the website retries them automatically. |
| Concurrent queries from one source are mixed up: answers carry another query's identifier or domain, repeat, or go missing.                                          | One query in flight per process (`maxQueriesInFlight: 1`), and every answer's echoed domain must match its query.                                                                                                                                         |
| A query with an outdated cookie is answered with `CK <cookie> <qid>`.                                                                                                | The cookie lives for the process; a renewal resends the query once.                                                                                                                                                                                       |
| Internationalized names arrive as `unicode                                                                                                                           | ace`, not `ace                                                                                                                                                                                                                                            | unicode`. | The Unicode form is the domain name. |
| Payment-exempt registrations say `Exempt from payment`, not `0`.                                                                                                     | Both map to `ExemptFromPayment`.                                                                                                                                                                                                                          |
| Status 3 also covers malformed names (`Invalid domain`) and unknown categories (`Invalid TLD`).                                                                      | `UnavailableReason` classifies the English message.                                                                                                                                                                                                       |
| Release timestamps have no zone.                                                                                                                                     | They are read as Brasília time (UTC−03:00, without daylight saving time since 2019).                                                                                                                                                                      |
| The server is `avail.registro.br`, not the `whois.registro.br` the README names.                                                                                     | `IsavailClientSettings.registryHost`.                                                                                                                                                                                                                     |

Statuses 1, 5, 6, 7, and 9 could not be observed live; their parsing follows the specification's
examples and the official Python client.

## Workspaces

| Workspace                        | Role                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/availability-contract` | Domain vocabulary (`DomainName`, `DomainAvailability`), the relay HTTP contract, local development constants, and the `RegistryRelayStack` reference. Both apps depend on it; neither imports the other. |
| `apps/relay`                     | ISAVAIL protocol, UDP client, relay HTTP server, Fly.io Service, and the relay Stack.                                                                                                                    |
| `apps/web`                       | Public HTTP API (`/v1`), availability checker and KV cache, Foldkit website, and the web Stack.                                                                                                          |
| `packages/shared-infrastructure` | The observability Stack (Axiom datasets and ingest tokens), its `ObservabilityStack` reference, `telemetryExportVariables`, and `isAlchemyDev`. Both apps depend on it.                                  |
| `tools/oxlint-plugin-isavail`    | Lint rule that keeps service constructors out of runtime imports.                                                                                                                                        |

## Stacks and lifecycle

All three Stacks keep state in the same Cloudflare state store. That lets the web Stack read the
relay Stack's outputs and both app Stacks read the observability Stack's outputs.

| Resource                                                 | Owning Stack           | Isolation                                     | Local provider                                      |
| -------------------------------------------------------- | ---------------------- | --------------------------------------------- | --------------------------------------------------- |
| Relay Fly App, Machine, shared IPv4                      | `IsavailRegistryRelay` | Stage-isolated; names are generated per stage | None; see below                                     |
| Relay access token (`Alchemy.Random`) and its Fly secret | `IsavailRegistryRelay` | Stage-isolated                                | None; local development uses a fixed loopback token |
| `AvailabilityApi` Worker                                 | `IsavailWeb`           | Stage-isolated                                | workerd under `alchemy dev`                         |
| `Website` Worker and assets                              | `IsavailWeb`           | Stage-isolated                                | Vite dev server and workerd under `alchemy dev`     |
| `AvailabilityCache` KV namespace                         | `IsavailWeb`           | Stage-isolated                                | Local KV under `alchemy dev`                        |
| Relay telemetry header Fly secrets                       | `IsavailRegistryRelay` | Stage-isolated                                | None; `Command.Dev` env under `alchemy dev`         |
| Axiom trace and log datasets, ingest tokens              | `IsavailObservability` | Permanent, stage `production` only; shared    | None; always live                                   |

The observability Stack is the documented exception to stage isolation. Stage `production` exports
to the production datasets, and every other stage, local development included, exports to the
shared preview datasets. See [`docs/observability.md`](observability.md).

Deploy `IsavailObservability` once (`vp run deploy:observability`) before any application stage.
Production deploys redeploy it first through `dependsOn`. Application Stacks never destroy it.

Ordering of the application Stacks:

1. Deploy `IsavailRegistryRelay` for a stage, then `IsavailWeb` for the same stage. The web Stack
   binds the relay `url` and `accessToken` outputs of its own stage. `vp run @isavail/web#deploy`
   runs the relay deployment first through `dependsOn`.
2. Destroy `IsavailWeb` first, then `IsavailRegistryRelay`. `vp run @isavail/relay#destroy` runs
   the web destruction first.
3. Both Stacks read the stage from `--stage`, `ALCHEMY_STAGE`, or the default `live_${USER}`. Set
   `ALCHEMY_STAGE` once so both Stacks resolve the same stage; the production tasks pass
   `--stage production` to both.

### Local development exception

Alchemy has no local provider for Fly.io. Under `alchemy dev` the web Stack therefore binds the
API Worker to `LOCAL_REGISTRY_RELAY_URL` (`http://127.0.0.1:4310`) and a fixed token. The relay
Stack (`vp run @isavail/relay#dev`, which runs `alchemy dev`) declares no Fly resources. Instead it
runs the same relay program under Node on the loopback interface through `Command.Dev`, with the
preview telemetry variables. This
follows the standards' rule that a missing local provider must not route local traffic through
production. The local relay holds no data and serves only the developer's machine. Like every
stage, it talks to the real Registro.br, which nothing can emulate, and spends the developer's own
query budget.

## Caching

The API Worker remembers each Registro.br answer in Workers KV for as long as that kind of answer
stays trustworthy: 5 minutes for available domains, 15 to 30 minutes for domains being released,
6 hours for registered domains, and 24 hours for unavailable names. Failed lookups are never
cached. A check served from the cache says so with `servedFromCache: true`.

## Public API

`POST /v1/availability-checks` accepts up to 50 domains or bare names (`minhaempresa` is checked
as `minhaempresa.com.br`). `GET /v1/domains/:domain/availability` checks one. Both return a
`DomainCheckReport` with a `requestId`. The OpenAPI document is served at `/v1/openapi.json` and
checked in at `apps/web/openapi.json`; regenerate it with `vp run generate:openapi`.

## Not yet done

- No stage has been deployed. Deploying the relay needs a Fly.io token in the Alchemy profile
  (`alchemy profile`), and outbound UDP from Fly Machines should be confirmed on the first deploy.
- The relay's Fly egress address is shared. A dedicated egress address is needed before asking
  Registro.br (`isavail@registro.br`) to register the relay as a proxy, or to raise its limit.
- Registro.br has not been asked whether its terms allow offering this availability data to
  third parties as a service.
- The observability Stack has not been deployed yet. Deploying it needs the Axiom credentials in
  the Alchemy profile; see the unverified items in `docs/observability.md`.
