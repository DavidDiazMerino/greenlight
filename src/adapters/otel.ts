import type { LocalLog, MediaQaResult, Span } from "../types.ts";

export interface TelemetrySnapshot {
  metrics: MediaQaResult[];
  logs: LocalLog[];
  traces: Span[];
}

export interface TelemetryExporter {
  readonly identity: string;
  export(snapshot: TelemetrySnapshot): Promise<void>;
}

export class LocalArtifactExporter implements TelemetryExporter {
  readonly identity = "local-artifact-exporter";
  async export(_snapshot: TelemetrySnapshot): Promise<void> {
    // Persistence is performed by the canary runner so bundle hashing remains atomic.
  }
}

/**
 * OTLP/HTTP JSON boundary for a configured OpenTelemetry Collector. It is not
 * activated by the local demo and deliberately has no implicit credentials.
 */
export class OtlpHttpExporter implements TelemetryExporter {
  readonly identity = "otlp-http-json";
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  constructor(endpoint: string, headers: Record<string, string> = {}) {
    this.endpoint = endpoint;
    this.headers = headers;
    if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://localhost")) {
      throw new Error("OTLP endpoint must use HTTPS (or localhost for development)");
    }
  }

  async export(snapshot: TelemetrySnapshot): Promise<void> {
    const payloads = [
      ["v1/traces", { resourceSpans: toOtlpSpans(snapshot.traces) }],
      ["v1/logs", { resourceLogs: toOtlpLogs(snapshot.logs) }],
      ["v1/metrics", { resourceMetrics: toOtlpMetrics(snapshot.metrics) }],
    ] as const;
    for (const [path, body] of payloads) {
      const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`OTLP export failed at ${path}: HTTP ${response.status}`);
    }
  }
}

function attrs(values: Record<string, unknown>) {
  return Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "number" ? { doubleValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) } }));
}

function toOtlpSpans(spans: Span[]) {
  return [{ resource: { attributes: attrs({ "service.name": "greenlight-canary" }) }, scopeSpans: [{ scope: { name: "greenlight" }, spans: spans.map((span) => ({ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, startTimeUnixNano: String(span.startUnixMs * 1_000_000), endTimeUnixNano: String(span.endUnixMs * 1_000_000), attributes: attrs(span.attributes) })) }] }];
}

function toOtlpLogs(logs: LocalLog[]) {
  return [{ resource: { attributes: attrs({ "service.name": "greenlight-canary" }) }, scopeLogs: [{ scope: { name: "greenlight" }, logRecords: logs.map((log) => ({ timeUnixNano: String(Date.parse(log.timestamp) * 1_000_000), severityText: log.violation_px > 0 ? "ERROR" : "INFO", body: { stringValue: JSON.stringify(log) }, attributes: attrs(log) })) }] }];
}

function toOtlpMetrics(metrics: MediaQaResult[]) {
  const names: [string, (m: MediaQaResult) => number][] = [
    ["greenlight_render_duration_ms", (m) => m.renderDurationMs],
    ["greenlight_output_valid", (m) => Number(m.outputValid)],
    ["greenlight_caption_safe_area_pass", (m) => Number(m.safeAreaPass)],
    ["greenlight_caption_safe_area_violation_px", (m) => m.violationPx],
    ["greenlight_run_completed", (m) => Number(m.runCompleted)],
  ];
  return [{ resource: { attributes: attrs({ "service.name": "greenlight-canary" }) }, scopeMetrics: [{ scope: { name: "greenlight" }, metrics: names.map(([name, get]) => ({ name, gauge: { dataPoints: metrics.map((metric) => ({ attributes: attrs({ variant: metric.variant, clip_id: metric.clipId, experiment_id: metric.experimentId }), asDouble: get(metric), timeUnixNano: String(Date.now() * 1_000_000) })) } })) }] }];
}
