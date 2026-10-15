import * as Alchemy from "alchemy";
import type { Redacted } from "effect";

/** The only stage the observability Stack is deployed to. */
export const OBSERVABILITY_STAGE = "production";

/**
 * Outputs the observability Stack publishes for the application Stacks: where
 * every stage's OpenTelemetry signals go. Axiom's OTLP/HTTP endpoints and, per
 * signal, the headers that authenticate the request and select its dataset.
 */
export interface ObservabilityStackOutputs {
  /** OTLP/HTTP traces endpoint. */
  readonly tracesEndpoint: string;
  /**
   * Headers for trace exports, in the `OTEL_EXPORTER_OTLP_HEADERS` format
   * (`key=url-encoded value`, comma separated). Carries the ingest token.
   */
  readonly tracesHeaders: Redacted.Redacted<string>;
  /** OTLP/HTTP logs endpoint. */
  readonly logsEndpoint: string;
  /** Headers for log exports, in the same format as {@link tracesHeaders}. */
  readonly logsHeaders: Redacted.Redacted<string>;
}

/**
 * Reference to the observability Stack.
 *
 * It owns the Axiom datasets and ingest token every stage exports to, exists
 * only at {@link OBSERVABILITY_STAGE}, and is deployed before any application
 * stage reads it. Application Stacks never create Axiom resources, so their
 * deploys need no Axiom credentials. See `docs/observability.md`.
 */
export class ObservabilityStack extends Alchemy.Stack<
  ObservabilityStack,
  ObservabilityStackOutputs
>()("IsavailObservability") {}
