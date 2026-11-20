// Prometheus-compatible metrics registry for background service health monitoring.
// Exposes counters, gauges, and histograms in OpenMetrics text format.
//
// ⚠️  LIMITATION: This in-memory registry resets on process restart and is not
// suitable for multi-instance deployments. Metric values reflect only the
// current instance's state since last restart. For production deployments with
// multiple instances or persistent monitoring, use a proper Prometheus client
// library (e.g., prom-client) with persistent storage and cluster-aware aggregation.

type MetricValue = number;

interface MetricEntry {
  name: string;
  help: string;
  type: "counter" | "gauge";
  value: MetricValue;
  labels: Record<string, string>;
}

const registry: Map<string, MetricEntry> = new Map();

function metricKey(name: string, labels: Record<string, string>): string {
  const labelPairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return labelPairs ? `${name}{${labelPairs}}` : name;
}

function getOrCreate(
  name: string,
  help: string,
  type: "counter" | "gauge",
  labels: Record<string, string> = {},
): MetricEntry {
  const key = metricKey(name, labels);
  let entry = registry.get(key);
  if (!entry) {
    entry = { name, help, type, value: 0, labels };
    registry.set(key, entry);
  }
  return entry;
}

export function counterInc(
  name: string,
  help: string,
  labels: Record<string, string> = {},
  increment = 1,
): void {
  const entry = getOrCreate(name, help, "counter", labels);
  entry.type = "counter";
  entry.value += increment;
}

export function gaugeSet(
  name: string,
  help: string,
  value: number,
  labels: Record<string, string> = {},
): void {
  const entry = getOrCreate(name, help, "gauge", labels);
  entry.type = "gauge";
  entry.value = value;
}

export function gaugeInc(
  name: string,
  help: string,
  labels: Record<string, string> = {},
  increment = 1,
): void {
  const entry = getOrCreate(name, help, "gauge", labels);
  entry.type = "gauge";
  entry.value += increment;
}

export function gaugeDec(
  name: string,
  help: string,
  labels: Record<string, string> = {},
  decrement = 1,
): void {
  const entry = getOrCreate(name, help, "gauge", labels);
  entry.type = "gauge";
  entry.value -= decrement;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return parts ? `{${parts}}` : "";
}

export function getMetricsText(): string {
  const lines: string[] = [];

  // Group by metric name for HELP/TYPE headers
  const seen = new Set<string>();
  for (const entry of registry.values()) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      lines.push(`# HELP ${entry.name} ${entry.help}`);
      lines.push(`# TYPE ${entry.name} ${entry.type}`);
    }
    const labels = formatLabels(entry.labels);
    lines.push(`${entry.name}${labels} ${entry.value}`);
  }

  return lines.join("\n") + "\n";
}

// ── Predefined service metrics ───────────────────────────────────────────

export const Metrics = {
  // Event indexer
  eventsIngested: (count = 1) =>
    counterInc(
      "novasupport_events_ingested_total",
      "Total number of support events ingested by indexer",
      {},
      count,
    ),
  eventIndexerErrors: () =>
    counterInc(
      "novasupport_event_indexer_errors_total",
      "Total number of indexer poll errors",
    ),
  eventIndexerLastSuccess: (timestampMs: number) =>
    gaugeSet(
      "novasupport_event_indexer_last_success_ts",
      "Unix timestamp of last successful indexer poll",
      timestampMs,
    ),
  orphanCount: (count: number) =>
    gaugeSet(
      "novasupport_orphan_transactions",
      "Number of orphaned transactions awaiting profile resolution",
      count,
    ),
  circuitBreakerState: (state: string) =>
    gaugeSet(
      "novasupport_circuit_breaker_state",
      "Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)",
      state === "CLOSED" ? 0 : state === "OPEN" ? 1 : 2,
    ),

  // Drip scheduler
  dripsProcessed: (count = 1) =>
    counterInc(
      "novasupport_drips_processed_total",
      "Total number of recurring drips processed",
      {},
      count,
    ),
  dripErrors: () =>
    counterInc(
      "novasupport_drip_errors_total",
      "Total number of drip processing errors",
    ),

  // Webhook processor
  webhooksDelivered: (count = 1) =>
    counterInc(
      "novasupport_webhooks_delivered_total",
      "Total number of webhooks delivered successfully",
      {},
      count,
    ),
  webhookDeliveryErrors: () =>
    counterInc(
      "novasupport_webhook_delivery_errors_total",
      "Total number of webhook delivery errors",
    ),
  webhookRetries: () =>
    counterInc(
      "novasupport_webhook_retries_total",
      "Total number of webhook retry attempts",
    ),
  webhookQueueDepth: (count: number) =>
    gaugeSet(
      "novasupport_webhook_queue_depth",
      "Number of pending webhook deliveries in queue",
      count,
    ),
};
