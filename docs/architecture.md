# Architecture

isavail checks whether `.br` domains can be registered, for people choosing a company name and
for AI agents generating them. Every answer comes from Registro.br's official ISAVAIL
availability service.

It is one self-hosted Node process:

```text
browser / Agent
   │  HTTP
   ▼
isavail (Node 24, one process)
   ├── /            Foldkit website (static files from dist/client, SPA fallback)
   ├── /v1/*        public HTTP API ──▶ AvailabilityChecker
   │                                      ├── AvailabilityCache ──▶ SQLite file (node:sqlite)
   │                                      └── IsavailClient ──UDP 43, ISAVAIL──▶ avail.registro.br
   └── OTLP/HTTP ──▶ OpenTelemetry collector (optional)
```

ISAVAIL is UDP only: `avail.registro.br` refuses TCP on port 43. A plain Node process can open
UDP sockets, so the HTTP API asks Registro.br directly. No relay or second service sits in between.

## One process, one source address

Registro.br issues its cookie and its query budget per source address, and `IsavailClient` paces
itself with a process-local rate limiter (`RateLimiter.layerStoreMemory`). Run one process per
public address. A second process behind the same address would spend the same budget without
knowing it, and would then need a shared store such as `RateLimiter.layerStoreRedis`.

Registro.br can register a fixed address as a proxy (the protocol's `[ip]` field) or raise its
limit. Ask `isavail@registro.br` for either.

## Registro.br behavior the client depends on

Measured against the live service on 2026-10-15. The published specification in
`Protocolo-ISAVAIL.txt` differs from the live service in several places; the client follows the
live service.

| Behavior                                                                                                                                                             | Consequence in code                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each source address gets a token bucket of 30 queries that refills at one query per second. An empty bucket turns every query into `ST 8 Query rate limit exceeded`. | `IsavailClientSettings`: burst 25, refill one per 1.2 s, an adaptive cooldown after a refusal, and a 5 s pacing budget per request. Domains beyond the budget are `RegistryRateLimited` with `retryAfterSeconds`; the website retries them automatically. |
| Concurrent queries from one source are mixed up: answers carry another query's identifier or domain, repeat, or go missing.                                          | One query in flight per process (`maxQueriesInFlight: 1`), and every answer's echoed domain must match its query.                                                                                                                                         |
| A query with an outdated cookie is answered with `CK <cookie> <qid>`.                                                                                                | The cookie lives for the process; a renewal resends the query once.                                                                                                                                                                                       |
| Internationalized names arrive as `unicode\|ace`, not `ace\|unicode`.                                                                                                | The Unicode form is the domain name.                                                                                                                                                                                                                      |
| Payment-exempt registrations say `Exempt from payment`, not `0`.                                                                                                     | Both map to `ExemptFromPayment`.                                                                                                                                                                                                                          |
| Status 3 also covers malformed names (`Invalid domain`) and unknown categories (`Invalid TLD`).                                                                      | `UnavailableReason` classifies the English message.                                                                                                                                                                                                       |
| Release timestamps have no zone.                                                                                                                                     | They are read as Brasília time (UTC−03:00, without daylight saving time since 2019).                                                                                                                                                                      |
| The server is `avail.registro.br`, not the `whois.registro.br` the README names.                                                                                     | `IsavailClientSettings.registryHost`.                                                                                                                                                                                                                     |

Statuses 1, 5, 6, 7, and 9 could not be observed live; their parsing follows the specification's
examples and the official Python client.

## Source layout

Everything lives in one app, `apps/isavail`. `tools/oxlint-plugin-isavail` holds the lint rule
that keeps service constructors out of runtime imports.

| Directory          | Role                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain`       | Domain vocabulary shared by the server and the website: `DomainName`, `DomainAvailability`.                                                           |
| `src/registry`     | ISAVAIL protocol codec, the UDP `IsavailClient`, and the `RegistryLookup` outcome type.                                                               |
| `src/api`          | Public HTTP contract (`AvailabilityHttpApi`), its handlers, `AvailabilityChecker`, and the SQLite `AvailabilityCache`.                                |
| `src/server`       | Composition root (`main.ts`): HTTP server, static website, configuration, and OpenTelemetry (`telemetry.ts`).                                         |
| `src/client`       | Foldkit website. It imports `src/domain`, `src/registry/registry-lookup.ts`, and `src/api/availability-http-api.ts` only, so no Node code reaches it. |
| `scripts`          | `dev.ts` (development supervisor) and `generate-openapi.ts`.                                                                                          |
| `nix`, `flake.nix` | Nix package and NixOS module.                                                                                                                         |

## Build

`vp run build` produces two outputs under `apps/isavail/dist`:

- `client/`: the website, from `vite.config.ts`. Files under `assets/` are fingerprinted and
  served with `Cache-Control: immutable`; `index.html` is served with `no-cache`.
- `server/main.js`: the server and every JavaScript dependency bundled into one ES module, from
  `vite.server.config.ts`. Node built-ins such as `node:sqlite` and `node:dgram` stay external, so
  running it needs Node 24 and nothing else. No `node_modules` ship.

`node dist/server/main.js` serves `dist/client` by default. The Nix package installs both under
`lib/isavail` and wraps Node as `bin/isavail`.

## Configuration

All configuration is environment variables.

| Variable              | Default                       | Meaning                                                               |
| --------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `ISAVAIL_HOST`        | `127.0.0.1`                   | Address to listen on.                                                 |
| `ISAVAIL_PORT`        | `4310`                        | Port for the website and `/v1`.                                       |
| `ISAVAIL_DATABASE`    | `isavail.sqlite` (in the cwd) | SQLite cache file. Created with its table on first start.             |
| `ISAVAIL_WEBSITE_DIR` | `../client` beside `main.js`  | Built website. Without an `index.html` there, only the API is served. |
| `OTEL_*`              | see `docs/observability.md`   | OpenTelemetry export. Nothing is exported unless an endpoint is set.  |

## Caching

`AvailabilityCache` remembers each Registro.br answer in the SQLite table `availability_cache` for as
long as that kind of answer stays trustworthy: 5 minutes for available domains, 15 to 30 minutes for
domains being released, 6 hours for registered domains, and 24 hours for unavailable names. Failed
lookups are never cached. Expired rows are deleted whenever new answers are written. A check served
from the cache says so with `servedFromCache: true`.

The cache survives restarts, so restarting the service does not spend Registro.br's budget again.
Deleting the file is always safe; the table is recreated on the next start. The SQLite client uses
WAL mode, so the directory also holds `-wal` and `-shm` files while the service runs. A cache that
cannot be read or written behaves as empty and logs a warning; a file that cannot be opened at
startup stops the service.

## Public API

`POST /v1/availability-checks` accepts up to 50 domains or bare names (`minhaempresa` is checked
as `minhaempresa.com.br`). `GET /v1/domains/:domain/availability` checks one. Both return a
`DomainCheckReport` with a `requestId`. `GET /v1/health` answers 204 without asking Registro.br.
Unknown `/v1` paths answer 404; every other unknown path that a browser requests gets the website's
`index.html`.

The OpenAPI document is served at `/v1/openapi.json` and checked in at `apps/isavail/openapi.json`;
regenerate it with `vp run generate:openapi`.

## Not yet done

- Registro.br has not been asked whether its terms allow offering this availability data to
  third parties as a service.
- The NixOS VM test (`checks.<linux>.nixos-module`) has been evaluated but not yet run; run
  `nix flake check` on a Linux machine.
