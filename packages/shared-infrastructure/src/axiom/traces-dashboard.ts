/**
 * The "isavail traces" Axiom dashboard, owned by the observability Stack.
 *
 * Every chart reads the traces dataset narrowed by the dashboard's filter bar:
 * a stage (from the `alchemy.stage` resource attribute) and a service (from
 * `service.name`). Both default to everything.
 *
 * The domain charts depend on span names and attributes set in the apps:
 *
 * - `AvailabilityChecker.checkDomains` with `availability.domain_count` and
 *   `availability.cached_count` (`apps/web/src/api/availability-checker.ts`);
 * - `RegistryRelayClient.lookUpDomains`, the API Worker's call to the relay
 *   (`apps/web/src/api/registry-relay-client.ts`);
 * - `IsavailClient.lookUpDomains`, the relay's ISAVAIL exchange with
 *   Registro.br (`apps/relay/src/isavail-client.ts`).
 *
 * Renaming one of those spans or attributes empties its chart; update the
 * queries here in the same change.
 */
import type * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import { Array, Effect } from "effect";
import { TELEMETRY_SERVICE_NAMES } from "../telemetry-services.ts";
import { TracesDataset } from "./telemetry-datasets.ts";

/** Dashboard filter IDs; each is also an APL query parameter of every chart. */
const STAGE_FILTER = "stage";
const SERVICE_FILTER = "service";

/** A chart whose query is the filtered traces dataset followed by `pipeline`. */
interface TracesChart {
  readonly id: string;
  readonly name: string;
  readonly type: "Statistic" | "TimeSeries" | "Table";
  /** APL operators applied to the filtered traces, starting with `|`. */
  readonly pipeline: string;
  /** Grid cell on the 12-column dashboard layout. */
  readonly cell: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/**
 * True for a failed span. Axiom adds the status columns only once a span with
 * that status arrives, so `column_ifexists` keeps queries valid on a dataset
 * that has not recorded a failure yet.
 */
const IS_FAILED = `tostring(column_ifexists("status.code", "")) == "ERROR"`;

/**
 * Server spans of real requests: health checks are left out so they cannot
 * drown the request charts. The Routes table still lists them.
 */
const SERVED_REQUESTS = `where kind == "server" and tostring(['attributes.http.route']) != "/v1/health"`;

/** `duration` is a timespan; dividing by `1ms` gives milliseconds as a number. */
const DURATION_MS = "extend duration_ms = duration / 1ms";

/**
 * Charts in layout order. The filter bar takes the first two rows
 * (`y: 0`, `h: 2`).
 */
export const TRACES_DASHBOARD_CHARTS: ReadonlyArray<TracesChart> = [
  {
    id: "requests",
    name: "Requests",
    type: "Statistic",
    pipeline: `| ${SERVED_REQUESTS}
| summarize requests = count()`,
    cell: { x: 0, y: 2, w: 3, h: 4 },
  },
  {
    id: "failed-requests",
    name: "Failed requests (%)",
    type: "Statistic",
    pipeline: `| ${SERVED_REQUESTS}
| summarize requests = count(), failed = countif(${IS_FAILED})
| project failed_percent = iff(requests == 0, 0.0, round(100.0 * failed / requests, 2))`,
    cell: { x: 3, y: 2, w: 3, h: 4 },
  },
  {
    id: "request-p95",
    name: "Request p95 (ms)",
    type: "Statistic",
    pipeline: `| ${SERVED_REQUESTS}
| ${DURATION_MS}
| summarize p95_ms = round(percentile(duration_ms, 95), 1)`,
    cell: { x: 6, y: 2, w: 3, h: 4 },
  },
  {
    id: "cached-answers",
    name: "Answers served from cache (%)",
    type: "Statistic",
    pipeline: `| where name == "AvailabilityChecker.checkDomains"
| summarize domains = sum(toint(['attributes.custom']['availability.domain_count'])),
            cached = sum(toint(['attributes.custom']['availability.cached_count']))
| project cached_percent = iff(domains == 0, 0.0, round(100.0 * cached / domains, 1))`,
    cell: { x: 9, y: 2, w: 3, h: 4 },
  },
  {
    id: "requests-by-service",
    name: "Requests by service",
    type: "TimeSeries",
    pipeline: `| ${SERVED_REQUESTS}
| summarize requests = count() by ['service.name'], bin_auto(_time)`,
    cell: { x: 0, y: 6, w: 6, h: 6 },
  },
  {
    id: "request-latency",
    name: "Request latency (ms)",
    type: "TimeSeries",
    pipeline: `| ${SERVED_REQUESTS}
| ${DURATION_MS}
| summarize p50 = percentile(duration_ms, 50),
            p95 = percentile(duration_ms, 95),
            p99 = percentile(duration_ms, 99)
    by bin_auto(_time)`,
    cell: { x: 6, y: 6, w: 6, h: 6 },
  },
  {
    id: "responses-by-status",
    name: "Responses by status class",
    type: "TimeSeries",
    pipeline: `| ${SERVED_REQUESTS}
| extend status_code = toint(['attributes.http.response.status_code'])
| where isnotnull(status_code)
| summarize responses = count() by status_class = strcat(tostring(status_code / 100), "xx"), bin_auto(_time)`,
    cell: { x: 0, y: 12, w: 6, h: 6 },
  },
  {
    id: "registry-lookup-latency",
    name: "Registro.br lookup p95 (ms): Worker → relay vs relay → Registro.br",
    type: "TimeSeries",
    pipeline: `| where name in ("RegistryRelayClient.lookUpDomains", "IsavailClient.lookUpDomains")
| ${DURATION_MS}
| summarize p95 = percentile(duration_ms, 95) by name, bin_auto(_time)`,
    cell: { x: 6, y: 12, w: 6, h: 6 },
  },
  {
    id: "domains-checked",
    name: "Domains checked: fresh vs cached",
    type: "TimeSeries",
    pipeline: `| where name == "AvailabilityChecker.checkDomains"
| extend domains = toint(['attributes.custom']['availability.domain_count']),
         cached = toint(['attributes.custom']['availability.cached_count'])
| summarize fresh = sum(domains - cached), cached = sum(cached) by bin_auto(_time)`,
    cell: { x: 0, y: 18, w: 6, h: 6 },
  },
  {
    id: "slowest-operations",
    name: "Slowest operations",
    type: "Table",
    pipeline: `| where kind != "server"
| ${DURATION_MS}
| summarize spans = count(),
            p50_ms = round(percentile(duration_ms, 50), 1),
            p95_ms = round(percentile(duration_ms, 95), 1),
            max_ms = round(max(duration_ms), 1)
    by ['service.name'], name
| order by p95_ms desc
| take 25`,
    cell: { x: 6, y: 18, w: 6, h: 6 },
  },
  {
    id: "routes",
    name: "Routes",
    type: "Table",
    pipeline: `| where kind == "server"
| ${DURATION_MS}
| summarize requests = count(),
            failed = countif(${IS_FAILED}),
            p50_ms = round(percentile(duration_ms, 50), 1),
            p95_ms = round(percentile(duration_ms, 95), 1)
    by ['service.name'],
       method = tostring(['attributes.http.request.method']),
       route = tostring(['attributes.http.route'])
| extend failed_percent = round(100.0 * failed / requests, 2)
| order by requests desc
| take 50`,
    cell: { x: 0, y: 24, w: 12, h: 8 },
  },
  {
    id: "recent-errors",
    name: "Recent errors",
    type: "Table",
    pipeline: `| where ${IS_FAILED}
| summarize errors = count(),
            last_seen = todatetime(max(_time)),
            example_trace_ids = make_set(trace_id, 3)
    by stage_name = tostring(['resource.custom']['alchemy.stage']),
       ['service.name'],
       name,
       message = tostring(column_ifexists("status.message", ""))
| order by last_seen desc
| take 50`,
    cell: { x: 0, y: 32, w: 12, h: 8 },
  },
];

/**
 * The full APL of a chart: the dashboard's filter parameters, the traces
 * dataset narrowed by them, then the chart's `pipeline`.
 */
const tracesChartApl = (dataset: string, pipeline: string): string =>
  Array.join(
    [
      `declare query_parameters (${STAGE_FILTER}:string = "", ${SERVICE_FILTER}:string = "");`,
      `['${dataset}']`,
      `| where isempty(${STAGE_FILTER}) or tostring(['resource.custom']['alchemy.stage']) == ${STAGE_FILTER}`,
      `| where isempty(${SERVICE_FILTER}) or ['service.name'] == ${SERVICE_FILTER}`,
      pipeline,
    ],
    "\n",
  );

/** APL that lists every stage seen in the dataset, as filter options. */
const stageOptionsApl = (dataset: string): string =>
  Array.join(
    [
      `['${dataset}']`,
      `| extend stage_name = tostring(['resource.custom']['alchemy.stage'])`,
      `| where stage_name != ""`,
      `| distinct stage_name`,
      `| sort by stage_name asc`,
      `| project key = stage_name, value = stage_name`,
    ],
    "\n",
  );

/** One chart of the Axiom dashboard document. */
type DashboardChart = Axiom.DashboardProps["dashboard"]["charts"][number];

const toDashboardChart = (chart: TracesChart, dataset: string): DashboardChart => {
  const query = { apl: tracesChartApl(dataset, chart.pipeline) };

  switch (chart.type) {
    case "Statistic":
      return { id: chart.id, name: chart.name, type: "Statistic", query };
    case "TimeSeries":
      return { id: chart.id, name: chart.name, type: "TimeSeries", query };
    case "Table":
      return { id: chart.id, name: chart.name, type: "Table", query };
  }
};

/** Every chart of the dashboard, the filter bar first, reading `dataset`. */
export const tracesDashboardCharts = (dataset: string): Array<DashboardChart> => [
  {
    id: "filters",
    type: "SmartFilter",
    name: "Filters",
    filters: [
      {
        id: STAGE_FILTER,
        name: "Stage",
        type: "select",
        selectType: "query",
        active: true,
        options: [{ key: "All stages", value: "", default: true, unset: true }],
        query: { apl: stageOptionsApl(dataset) },
      },
      {
        id: SERVICE_FILTER,
        name: "Service",
        type: "select",
        selectType: "list",
        active: true,
        options: [
          { key: "All services", value: "", default: true, unset: true },
          { key: "API Worker", value: TELEMETRY_SERVICE_NAMES.availabilityApi },
          { key: "Registro.br relay", value: TELEMETRY_SERVICE_NAMES.registryRelay },
        ],
      },
    ],
  },
  ...Array.map(TRACES_DASHBOARD_CHARTS, (chart) => toDashboardChart(chart, dataset)),
];

/**
 * The dashboard. Its charts are built from the dataset's `name` Output, so
 * Alchemy creates it after the traces dataset exists.
 */
export const TracesDashboard = Axiom.Dashboard(
  "TracesDashboard",
  Effect.gen(function* () {
    const traces = yield* TracesDataset;

    const props: Alchemy.InputProps<Axiom.DashboardProps> = {
      dashboard: {
        name: "isavail traces",
        // Empty owner shares the dashboard with the whole organization; API
        // tokens cannot own private dashboards.
        owner: "",
        description:
          "Requests, latency, and errors of the isavail API Worker and Registro.br relay. " +
          "Filter by Alchemy stage and service.",
        refreshTime: 60,
        schemaVersion: 2,
        // Axiom accepts relative times only in the `qr-now-{duration}` form.
        timeWindowStart: "qr-now-24h",
        timeWindowEnd: "qr-now",
        charts: traces.name.pipe(Output.map(tracesDashboardCharts)),
        layout: [
          { i: "filters", x: 0, y: 0, w: 12, h: 2 },
          ...Array.map(TRACES_DASHBOARD_CHARTS, (chart) => ({ i: chart.id, ...chart.cell })),
        ],
      },
    };

    return props;
  }),
);
