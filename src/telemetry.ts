import type { LocalLog, MediaQaResult, Span } from "./types.ts";
import { stableId } from "./util.ts";

export function buildLog(result: MediaQaResult, digest: string, timestamp: string): LocalLog {
  const bounds = result.captionBounds;
  return {
    timestamp,
    experiment_id: result.experimentId,
    clip_id: result.clipId,
    variant: result.variant,
    stage: result.safeAreaPass ? "media_qa.safe_area" : "caption_layout",
    safe_area_bbox: bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : null,
    violation_px: result.violationPx,
    compositor_digest: digest,
    provenance: "local/synthetic",
  };
}

export function buildTrace(result: MediaQaResult, digest: string, baseUnixMs: number): Span[] {
  const total = Math.max(7, Math.round(result.renderDurationMs));
  const stages = [
    "input.validate",
    "portrait.reframe",
    "caption.layout",
    "ffmpeg.render",
    "media_qa.safe_area",
    "telemetry.emit",
  ];
  const rootSpanId = stableId(result.traceId, "root").slice(0, 16);
  const common = {
    experiment_id: result.experimentId,
    variant: result.variant,
    clip_id: result.clipId,
    compositor_digest: digest,
    provenance: "local/synthetic",
  };
  const root: Span = {
    traceId: result.traceId,
    spanId: rootSpanId,
    name: "canary.run",
    startUnixMs: baseUnixMs,
    endUnixMs: baseUnixMs + total,
    attributes: { ...common, output_valid: result.outputValid, safe_area_pass: result.safeAreaPass },
  };
  let cursor = baseUnixMs;
  const weights = [0.03, 0.08, 0.09, 0.68, 0.1, 0.02];
  const children = stages.map((name, index) => {
    const duration = index === stages.length - 1 ? baseUnixMs + total - cursor : Math.max(1, Math.round(total * weights[index]));
    const span: Span = {
      traceId: result.traceId,
      spanId: stableId(result.traceId, name).slice(0, 16),
      parentSpanId: rootSpanId,
      name,
      startUnixMs: cursor,
      endUnixMs: cursor + duration,
      attributes: { ...common, ...(name === "media_qa.safe_area" ? { violation_px: result.violationPx } : {}) },
    };
    cursor += duration;
    return span;
  });
  return [root, ...children];
}

export function prometheusText(metrics: MediaQaResult[]): string {
  const specs: [string, (metric: MediaQaResult) => number][] = [
    ["greenlight_render_duration_ms", (m) => m.renderDurationMs],
    ["greenlight_output_valid", (m) => Number(m.outputValid)],
    ["greenlight_caption_safe_area_pass", (m) => Number(m.safeAreaPass)],
    ["greenlight_caption_safe_area_violation_px", (m) => m.violationPx],
    ["greenlight_run_completed", (m) => Number(m.runCompleted)],
  ];
  return `${specs.flatMap(([name, get]) => metrics.map((metric) =>
    `${name}{variant="${metric.variant}",clip_id="${metric.clipId}",experiment_id="${metric.experimentId}"} ${get(metric)}`
  )).join("\n")}\n`;
}
