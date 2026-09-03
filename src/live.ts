import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { copyFile } from "node:fs/promises";
import { GeminiAdkExperimentPlanner } from "./adapters/gemini.ts";
import { GoogleAdkAgentRuntime } from "./adapters/google-adk-runtime.ts";
import { createGrafanaCloudMcpToolset, extractGrafanaDashboardUrl, GRAFANA_CLOUD_MCP_ENDPOINT, normalizeGrafanaStackUrl, normalizeMcpEndpoint, runGrafanaEvidenceAgent } from "./adapters/grafana-adk.ts";
import { authorizeGrafanaMcp, PersistentGrafanaOAuthProvider } from "./adapters/grafana-oauth.ts";
import { OtlpHttpExporter } from "./adapters/otel.ts";
import { runCanary, type CanaryResult } from "./canary.ts";
import type { DecisionCard, DecisionOutcome, DecisionReceipt, EvidenceBundle, EvidenceCasefile } from "./types.ts";
import { hashFile, projectRoot, readJson, writeJson } from "./util.ts";
import { evaluatePolicy, loadPolicy } from "./policy.ts";

const GREENLIGHT_DASHBOARD_UID = "greenlight-release-gate";
const GREENLIGHT_DASHBOARD_TITLE = "Greenlight Release Gate";
const GREENLIGHT_ALERT_TITLE = "Greenlight caption safe-area violation";

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
  const canary = process.env.GREENLIGHT_REUSE_LATEST_CANARY === "true"
    ? await loadLatestCanary()
    : await runCanary({ planner });

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
  const highestFailure = canary.evidenceBundle.metrics
    .filter((item) => item.variant === "candidate" && !item.safeAreaPass)
    .sort((left, right) => right.violationPx - left.violationPx || left.clipId.localeCompare(right.clipId))[0];
  if (!highestFailure) throw new Error("Live investigation requires a measured candidate failure");
  const decisionAnnotation = [
    `${canary.decisionCard.decision} · caption-safe-area-9x16`,
    `${canary.decisionCard.affectedAssets.length}/8 candidate clips`,
    `root cause clip ${highestFailure.clipId}`,
    `max overflow ${highestFailure.violationPx} px`,
    `trace ${highestFailure.traceId}`,
    `decision receipt ${canary.decisionReceipt.fingerprint}`,
    "Verdict owner: deterministic-policy-evaluator",
  ].join(" · ");
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
        highestFailure: {
          clipId: highestFailure.clipId,
          violationPx: highestFailure.violationPx,
          traceId: highestFailure.traceId,
        },
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
      workflowPlan: [
        {
          kind: "alert",
          toolName: "alerting_manage_rules",
          args: {
            operation: "list",
            search_rule_name: GREENLIGHT_ALERT_TITLE,
            states: ["firing"],
            rule_limit: 10,
            limit_alerts: 10,
          },
        },
        {
          kind: "dashboard-search",
          toolName: "search_dashboards",
          args: { query: GREENLIGHT_DASHBOARD_TITLE, limit: 10, page: 1 },
        },
        {
          kind: "annotation",
          toolName: "create_annotation",
          args: {
            dashboardUid: GREENLIGHT_DASHBOARD_UID,
            time: new Date(canary.decisionCard.completedAt).getTime(),
            tags: ["greenlight", "release-gate", canary.experimentId, canary.decisionCard.decision.toLowerCase()],
            text: decisionAnnotation,
            data: {
              experimentId: canary.experimentId,
              decisionReceiptFingerprint: canary.decisionReceipt.fingerprint,
              policyOwner: "deterministic-policy-evaluator",
              verdictChangedByAgent: false,
              rootCauseClipId: highestFailure.clipId,
              rootCauseViolationPx: highestFailure.violationPx,
              rootCauseTraceId: highestFailure.traceId,
            },
          },
        },
        {
          kind: "navigation",
          toolName: "generate_deeplink",
          args: {
            resourceType: "dashboard",
            dashboardUid: GREENLIGHT_DASHBOARD_UID,
            timeRange: { from: window.from, to: window.to },
            queryParams: { "var-experiment_id": canary.experimentId },
            shorten: false,
          },
        },
      ],
    },
  });

  const alertCall = result.calls.find((call) => "kind" in call && call.kind === "alert");
  if (!alertCall || !resultContainsText(alertCall.result, GREENLIGHT_ALERT_TITLE) || !resultContainsText(alertCall.result, "firing")) {
    throw new Error(`Grafana Evidence Agent did not verify the firing alert: ${GREENLIGHT_ALERT_TITLE}`);
  }
  const dashboardSearchCall = result.calls.find((call) => "kind" in call && call.kind === "dashboard-search");
  if (!dashboardSearchCall || !resultContainsText(dashboardSearchCall.result, GREENLIGHT_DASHBOARD_UID)) {
    throw new Error(`Grafana Evidence Agent did not find dashboard UID: ${GREENLIGHT_DASHBOARD_UID}`);
  }
  const navigationCall = result.calls.find((call) => "kind" in call && call.kind === "navigation");
  const grafanaDashboardUrl = navigationCall ? extractGrafanaDashboardUrl(navigationCall.result, stackOrigin) : null;
  if (!grafanaDashboardUrl) throw new Error("Grafana Evidence Agent did not return a valid same-stack dashboard link");
  if (new URL(grafanaDashboardUrl).searchParams.get("var-experiment_id") !== canary.experimentId) {
    throw new Error("Grafana dashboard link is not scoped to the current experiment");
  }
  const traceReceipt = result.receipts.find((receipt) => receipt.kind === "traces" && receipt.traceIds?.includes(highestFailure.traceId));
  if (!traceReceipt) throw new Error(`Grafana trace evidence did not contain root-cause trace ${highestFailure.traceId}`);
  for (const expected of [highestFailure.clipId, String(highestFailure.violationPx), highestFailure.traceId]) {
    if (!result.narrative.diagnosis.includes(expected)) {
      throw new Error(`Grafana diagnosis did not preserve root-cause value: ${expected}`);
    }
  }

  const mcpProofs = result.receipts.map((receipt) => {
    const call = result.calls.find((item) => item.receiptId === receipt.receiptId);
    if (!call) throw new Error(`Missing raw MCP proof for receipt ${receipt.receiptId}`);
    return { receiptId: receipt.receiptId, result: call.result };
  });
  const loadedPolicy = await loadPolicy(join(projectRoot, "policy", "vertical-delivery-v1.yaml"));
  const liveDecision = evaluatePolicy({
    ...canary.evidenceBundle,
    provenance: "grafana-mcp",
    localReceipt: null,
    mcpReceipts: result.receipts,
    mcpProofs,
  }, loadedPolicy.policy, {
    requireMcp: true,
    resilience: canary.decisionCard.evidenceCasefile.resilience,
    canaryRun: canary.decisionCard.canaryRun,
  });
  if (liveDecision.decision !== canary.decisionCard.decision || liveDecision.reason !== canary.decisionCard.reason) {
    throw new Error(`MCP-required policy re-evaluation diverged: ${liveDecision.decision}/${liveDecision.reason}`);
  }

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
      workflowReceiptIds: result.workflowReceipts.map((receipt) => receipt.receiptId),
      mcpPolicyReevaluation: {
        decision: liveDecision.decision,
        reason: liveDecision.reason,
        rawProofsRehashed: mcpProofs.length,
        matchesLocalVerdict: true,
      },
    },
  });
  const decisionCard: DecisionCard = {
    ...canary.decisionCard,
    ...liveDecision,
    diagnosis: result.narrative.diagnosis,
    recommendedAction: result.narrative.recommendedAction,
    mcpReceipts: result.receipts,
    grafanaWorkflowReceipts: result.workflowReceipts,
    grafanaEvidenceRefs: [`artifacts/${canary.experimentId}/grafana-adk-run.json`],
    grafanaDashboardUrl,
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

async function loadLatestCanary(): Promise<CanaryResult> {
  const latest = join(projectRoot, "artifacts", "latest");
  const [decisionCard, evidenceBundle, evidenceCasefile, decisionReceipt, decisionOutcome] = await Promise.all([
    readJson<DecisionCard>(join(latest, "decision-card.json")),
    readJson<EvidenceBundle>(join(latest, "evidence-bundle.json")),
    readJson<EvidenceCasefile>(join(latest, "evidence-casefile.json")),
    readJson<DecisionReceipt>(join(latest, "decision-receipt.json")),
    readJson<DecisionOutcome>(join(latest, "decision-outcome.fixture.json")),
  ]);
  if (decisionCard.decisionReceiptFingerprint !== decisionReceipt.fingerprint
    || evidenceBundle.experimentId !== decisionCard.experimentId) {
    throw new Error("Latest canary artifacts are not internally consistent");
  }
  return {
    experimentId: decisionCard.experimentId,
    artifactDir: join(projectRoot, "artifacts", decisionCard.experimentId),
    decisionCard,
    evidenceBundle,
    evidenceCasefile,
    decisionReceipt,
    decisionOutcome,
  };
}

function resultContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(expected.toLowerCase());
  if (Array.isArray(value)) return value.some((item) => resultContainsText(item, expected));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => resultContainsText(item, expected));
  return false;
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
