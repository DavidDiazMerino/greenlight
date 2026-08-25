import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { copyFile } from "node:fs/promises";
import { GeminiAdkExperimentPlanner } from "./adapters/gemini.ts";
import { GoogleAdkAgentRuntime } from "./adapters/google-adk-runtime.ts";
import { createGrafanaCloudMcpToolset, GRAFANA_CLOUD_MCP_ENDPOINT, normalizeGrafanaStackUrl, normalizeMcpEndpoint, runGrafanaEvidenceAgent } from "./adapters/grafana-adk.ts";
import { authorizeGrafanaMcp, PersistentGrafanaOAuthProvider } from "./adapters/grafana-oauth.ts";
import { OtlpHttpExporter } from "./adapters/otel.ts";
import { runCanary } from "./canary.ts";
import type { DecisionCard } from "./types.ts";
import { hashFile, projectRoot, writeJson } from "./util.ts";

interface LiveConfig {
  project: string;
  location: string;
  model: string;
  grafanaUrl: string;
  mcpEndpoint: string;
  otlpEndpoint: string;
  otlpHeaders: Record<string, string>;
  ingestWaitMs: number;
}

export function loadLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required live integration setting: ${name}`);
    return value;
  };
  if (env.GOOGLE_GENAI_USE_ENTERPRISE?.toLowerCase() !== "true") {
    throw new Error("GOOGLE_GENAI_USE_ENTERPRISE=true is required so Gemini runs through Google Cloud Vertex AI");
  }
  const rawWait = Number(env.GREENLIGHT_GRAFANA_INGEST_WAIT_MS ?? 10_000);
  if (!Number.isFinite(rawWait) || rawWait < 0 || rawWait > 60_000) {
    throw new Error("GREENLIGHT_GRAFANA_INGEST_WAIT_MS must be between 0 and 60000");
  }
  return {
    project: required("GOOGLE_CLOUD_PROJECT"),
    location: required("GOOGLE_CLOUD_LOCATION"),
    model: required("GEMINI_MODEL"),
    grafanaUrl: normalizeGrafanaStackUrl(required("GRAFANA_URL")),
    mcpEndpoint: normalizeMcpEndpoint(env.GRAFANA_MCP_ENDPOINT?.trim() || GRAFANA_CLOUD_MCP_ENDPOINT),
    otlpEndpoint: required("OTEL_EXPORTER_OTLP_ENDPOINT"),
    otlpHeaders: parseOtlpHeaders(required("OTEL_EXPORTER_OTLP_HEADERS")),
    ingestWaitMs: rawWait,
  };
}

export async function runLiveIntegration(config = loadLiveConfig()): Promise<{
  artifactDir: string;
  capturePath: string;
  cardPath: string;
  decisionCard: DecisionCard;
}> {
  process.stdout.write(`Google Cloud: ${config.project} (${config.location}) · model ${config.model}\n`);
  process.stdout.write(`Grafana stack: ${new URL(config.grafanaUrl).origin}\n`);

  const exporter = new OtlpHttpExporter(config.otlpEndpoint, config.otlpHeaders);
  const oauthProvider = new PersistentGrafanaOAuthProvider();
  const stackOrigin = new URL(config.grafanaUrl).origin;
  const toolset = createGrafanaCloudMcpToolset({
    stackUrl: stackOrigin,
    endpoint: config.mcpEndpoint,
    authProvider: oauthProvider,
  });
  const adkRuntime = new GoogleAdkAgentRuntime({ model: config.model });
  const planner = new GeminiAdkExperimentPlanner(adkRuntime, config.model);
  const canary = await runCanary({ planner });

  await exporter.export({
    metrics: canary.evidenceBundle.metrics,
    logs: canary.evidenceBundle.logs,
    traces: canary.evidenceBundle.traces,
  });
  process.stdout.write("Exported the canary snapshot through OTLP/HTTP.\n");
  if (config.ingestWaitMs > 0) await delay(config.ingestWaitMs);

  await authorizeGrafanaMcp({ provider: oauthProvider, serverUrl: config.mcpEndpoint });
  const serverIdentity = `${config.mcpEndpoint}#${new URL(stackOrigin).hostname}`;
  const timestamps = canary.evidenceBundle.traces.flatMap((trace) => [trace.startUnixMs, trace.endUnixMs]);
  const window = {
    from: new Date(Math.min(...timestamps) - 60_000).toISOString(),
    to: new Date(Math.max(...timestamps) + 120_000).toISOString(),
  };
  const experimentSelector = JSON.stringify(canary.experimentId);
  const result = await runGrafanaEvidenceAgent({
    model: config.model,
    toolset,
    serverIdentity,
    mission: {
      experimentId: canary.experimentId,
      immutableVerdict: {
        decisionReceiptFingerprint: canary.decisionReceipt.fingerprint,
        decision: canary.decisionCard.decision,
        reason: canary.decisionCard.reason,
        policyHash: canary.decisionCard.policyHash,
      },
      window,
      localSummary: {
        candidateFailures: canary.evidenceBundle.metrics.filter((item) => item.variant === "candidate" && !item.safeAreaPass).length,
        maximumViolationPx: Math.max(...canary.evidenceBundle.metrics.map((item) => item.violationPx)),
        baselineTraceIds: canary.evidenceBundle.metrics.filter((item) => item.variant === "baseline").map((item) => item.traceId),
        candidateTraceIds: canary.evidenceBundle.metrics.filter((item) => item.variant === "candidate").map((item) => item.traceId),
      },
      queryPlan: [
        {
          kind: "metrics",
          toolName: "query_prometheus",
          args: {
            datasourceUid: "grafanacloud-prom",
            expr: `avg(greenlight_render_duration_ms{experiment_id=${experimentSelector}, variant="baseline"})`,
            startTime: window.from,
            endTime: window.to,
            stepSeconds: 30,
            queryType: "range",
          },
        },
        {
          kind: "metrics",
          toolName: "query_prometheus",
          args: {
            datasourceUid: "grafanacloud-prom",
            expr: `avg(greenlight_render_duration_ms{experiment_id=${experimentSelector}, variant="candidate"})`,
            startTime: window.from,
            endTime: window.to,
            stepSeconds: 30,
            queryType: "range",
          },
        },
        {
          kind: "logs",
          toolName: "query_loki_logs",
          args: {
            datasourceUid: "grafanacloud-logs",
            logql: `{service_name="greenlight-canary"} | json | experiment_id = ${experimentSelector}`,
            startRfc3339: window.from,
            endRfc3339: window.to,
          },
        },
        {
          kind: "traces",
          toolName: "tempo_traceql-search",
          args: {
            datasourceUid: "grafanacloud-traces",
            query: `{ resource.service.name = "greenlight-canary" && span.experiment_id = ${experimentSelector} }`,
            start: window.from,
            end: window.to,
          },
        },
      ],
    },
  });

  const capturePath = join(canary.artifactDir, "grafana-adk-run.json");
  await writeJson(capturePath, {
    ...result,
    decisionBinding: {
      owner: "deterministic-policy-evaluator",
      immutableDecisionReceiptFingerprint: canary.decisionReceipt.fingerprint,
      verdictChangedByAgent: false,
      backendValueReconstruction: Object.fromEntries((["metrics", "logs", "traces"] as const).map((kind) => [kind, {
        dataPresent: result.receipts.some((receipt) => receipt.kind === kind && receipt.dataPresent),
        receiptIds: result.receipts.filter((receipt) => receipt.kind === kind).map((receipt) => receipt.receiptId),
      }])),
    },
  });
  const decisionCard: DecisionCard = {
    ...canary.decisionCard,
    diagnosis: result.narrative.diagnosis,
    recommendedAction: result.narrative.recommendedAction,
    mcpReceipts: result.receipts,
    grafanaEvidenceRefs: [`artifacts/${canary.experimentId}/grafana-adk-run.json`],
    traceIds: [...new Set([...canary.decisionCard.traceIds, ...result.receipts.flatMap((receipt) => receipt.traceIds ?? [])])],
    geminiModel: config.model,
    replayCommand: "npm run agent:live",
  };
  const cardPath = join(canary.artifactDir, "decision-card.live.json");
  await writeJson(cardPath, decisionCard);
  const integrationIndex = join(canary.artifactDir, "live-integration-index.json");
  await writeJson(integrationIndex, {
    schemaVersion: "1.0",
    experimentId: canary.experimentId,
    generatedAt: result.completedAt,
    files: [
      { path: "grafana-adk-run.json", sha256: await hashFile(capturePath) },
      { path: "decision-card.live.json", sha256: await hashFile(cardPath) },
    ],
  });
  const latest = join(projectRoot, "artifacts", "latest");
  await Promise.all([
    copyFile(capturePath, join(latest, "grafana-adk-run.json")),
    copyFile(cardPath, join(latest, "decision-card.json")),
    copyFile(integrationIndex, join(latest, "live-integration-index.json")),
  ]);
  return { artifactDir: canary.artifactDir, capturePath, cardPath, decisionCard };
}

function parseOtlpHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new Error("OTEL_EXPORTER_OTLP_HEADERS must use comma-separated key=value entries");
    const key = decodeURIComponent(part.slice(0, separator).trim());
    const headerValue = decodeURIComponent(part.slice(separator + 1).trim());
    if (!key || !headerValue || /[\r\n]/.test(key + headerValue)) throw new Error("OTEL_EXPORTER_OTLP_HEADERS contains an invalid entry");
    headers[key] = headerValue;
  }
  return headers;
}
