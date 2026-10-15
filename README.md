# isavail

Checks whether `.br` domains can be registered, using Registro.br's official ISAVAIL availability
service. A Foldkit website and a public HTTP API run on Cloudflare; a small relay on Fly.io speaks
ISAVAIL's UDP protocol, which Cloudflare Workers cannot. See
[`docs/architecture.md`](docs/architecture.md).

## Develop

Requires Node 24 and [Vite+](https://viteplus.dev) (`vp`).

```sh
vp install
vp run dev        # relay on 127.0.0.1:4310 and the website on http://localhost:5180
```

`vp run dev` starts the relay Stack and the web Stack with `alchemy dev`. The relay runs under
Node, and the Workers and KV run locally. Lookups still reach the real Registro.br, which answers
a burst of about 30 queries and then about one per second. Local traces and logs go to the shared
preview datasets in Axiom, so the observability Stack must have been deployed once
(`vp run deploy:observability`).

## Check

```sh
vp check          # format, lint, and type-check
vp run -r test    # every workspace's tests
vp run generate:openapi
```

## Deploy

Both app Stacks use the Alchemy profile's Cloudflare credentials, and the relay also needs a Fly.io
token. The observability Stack needs Axiom credentials and is deployed once, before any app stage.
See [`docs/observability.md`](docs/observability.md).

```sh
vp run deploy:observability             # Axiom datasets and ingest tokens (stage production)
ALCHEMY_STAGE=preview vp run deploy     # relay Stack, then web Stack, for one stage
vp run deploy:production                # observability, relay, then web
ALCHEMY_STAGE=preview vp run destroy    # web Stack, then relay Stack
```

## Use from an Agent

```sh
curl -X POST https://<website>/v1/availability-checks \
  -H 'content-type: application/json' \
  -d '{"domains": ["minhaempresa", "minhaempresa.net.br"]}'
```

Each check's `availability._tag` says whether the domain can be registered. A check that comes back
`NotChecked` with `RegistryRateLimited` can be sent again after `retryAfterSeconds`. The contract is
at `/v1/openapi.json`.
