# isavail

Checks whether `.br` domains can be registered, using Registro.br's official ISAVAIL availability
service. One self-hosted Node process serves a Foldkit website and a public HTTP API, asks
Registro.br over UDP, and caches answers in SQLite. See [`docs/architecture.md`](docs/architecture.md).

## Develop

Requires Node 24 and [Vite+](https://viteplus.dev) (`vp`). `nix develop` provides Node and pnpm.

```sh
vp install
vp run dev        # website on http://localhost:5180, API on 127.0.0.1:4310
```

`vp run dev` runs the server under `node --watch` and Vite in parallel; Vite forwards `/v1` to the
server. Lookups reach the real Registro.br, which answers a burst of about 30 queries and then about
one per second. The development cache is `apps/isavail/isavail.sqlite`.

## Check

```sh
vp check          # format, lint, and type-check
vp run -r test    # every workspace's tests
vp run generate:openapi
```

## Run

```sh
vp run build      # apps/isavail/dist/{client,server}
vp run start      # builds, then serves both on http://127.0.0.1:4310
```

`dist/server/main.js` bundles every dependency, so `dist/` can be copied anywhere with Node 24 and
run with `node dist/server/main.js`. Configuration is environment variables (`ISAVAIL_HOST`,
`ISAVAIL_PORT`, `ISAVAIL_DATABASE`, `OTEL_*`); see [`docs/architecture.md`](docs/architecture.md#configuration).

## Run on NixOS

The flake provides `packages.<system>.default` and `nixosModules.default`:

```nix
{
  inputs.isavail.url = "github:<owner>/isavail";
  inputs.isavail.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, isavail, ... }: {
    nixosConfigurations.homelab = nixpkgs.lib.nixosSystem {
      modules = [
        isavail.nixosModules.default
        {
          services.isavail = {
            enable = true;
            # host = "0.0.0.0"; openFirewall = true;   # to serve the LAN directly
            openTelemetry.endpoint = "http://otel-collector.home.arpa:4318";
          };
        }
      ];
    };
  };
}
```

The service runs as a `DynamicUser` with its cache in `/var/lib/isavail`. By default it listens on
`127.0.0.1:4310`, for a reverse proxy in front. `nix flake check` on Linux runs a VM test of the
module. After changing `pnpm-lock.yaml`, update `pnpmDeps.hash` in `nix/package.nix`: set it to
`lib.fakeHash`, run `nix build`, and copy the hash Nix reports.

Telemetry is described in [`docs/observability.md`](docs/observability.md).

## Use from an Agent

```sh
curl -X POST http://<host>:4310/v1/availability-checks \
  -H 'content-type: application/json' \
  -d '{"domains": ["minhaempresa", "minhaempresa.net.br"]}'
```

Each check's `availability._tag` says whether the domain can be registered. A check that comes back
`NotChecked` with `RegistryRateLimited` can be sent again after `retryAfterSeconds`. The contract is
at `/v1/openapi.json`.
