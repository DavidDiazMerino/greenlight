import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { OtlpHttpExporter } from "../src/adapters/otel.ts";
import type { TelemetrySnapshot } from "../src/adapters/otel.ts";

const snapshot: TelemetrySnapshot = {
  metrics: [{
    experimentId: "exp-otlp-test", clipId: "v01", variant: "candidate", outputPath: "candidate.mp4", noCaptionPath: "no-caption.png",
    captionBounds: { x: 120, y: 1483, width: 840, height: 208 }, safeArea: { x: 90, y: 180, width: 900, height: 1450 },
    violationPx: 61, safeAreaPass: false, outputValid: true, width: 1080, height: 1920, durationSeconds: 6, expectedDurationSeconds: 6,
    renderDurationMs: 900, renderPath: "candidate-fused", compositorPasses: 1, runCompleted: true,
    traceId: "0123456789abcdef0123456789abcdef",
  }],
  logs: [{
    timestamp: "2026-08-24T00:00:00.000Z", experiment_id: "exp-otlp-test", clip_id: "v01", variant: "candidate", stage: "caption_layout",
    safe_area_bbox: [120, 1483, 840, 208], violation_px: 61, compositor_digest: "sha256:test", render_path: "candidate-fused",
    compositor_passes: 1, provenance: "local/synthetic",
  }],
  traces: [{
    traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", name: "canary.run",
    startUnixMs: 1_777_000_000_000, endUnixMs: 1_777_000_000_900,
    attributes: { experiment_id: "exp-otlp-test", variant: "candidate", clip_id: "v01" },
  }],
};

test("OTLP exporter sends traces, logs, and metrics with exact nanosecond strings", async () => {
  const requests: Array<{ path: string; authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", authorization: String(request.headers.authorization ?? ""), body: JSON.parse(body) });
      response.writeHead(200).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new OtlpHttpExporter(`http://127.0.0.1:${address.port}/otlp`, { Authorization: "Basic test-only" }).export(snapshot);
    assert.deepEqual(requests.map((request) => request.path), ["/otlp/v1/traces", "/otlp/v1/logs", "/otlp/v1/metrics"]);
    assert.ok(requests.every((request) => request.authorization === "Basic test-only"));
    const resourceSpans = requests[0].body.resourceSpans as Array<Record<string, unknown>>;
    const scopeSpans = resourceSpans[0].scopeSpans as Array<Record<string, unknown>>;
    const spans = scopeSpans[0].spans as Array<Record<string, unknown>>;
    assert.equal(spans[0].startTimeUnixNano, "1777000000000000000");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("OTLP exporter rejects insecure remote or credential-bearing endpoints", () => {
  assert.throws(() => new OtlpHttpExporter("http://example.com/otlp"), /HTTPS/);
  assert.throws(() => new OtlpHttpExporter("https://user:secret@example.com/otlp"), /embedded credentials/);
});
