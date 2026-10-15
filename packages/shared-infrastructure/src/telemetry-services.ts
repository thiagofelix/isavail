/**
 * `service.name` of each program that exports telemetry. The apps set these,
 * and the traces dashboard filters on them.
 */
export const TELEMETRY_SERVICE_NAMES = {
  /** The `AvailabilityApi` Cloudflare Worker. */
  availabilityApi: "isavail-availability-api",
  /** The Registro.br relay, on Fly.io or under `alchemy dev`. */
  registryRelay: "isavail-registry-relay",
} as const;
