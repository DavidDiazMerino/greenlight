import {
  InMemorySessionService,
  LlmAgent,
  MCPToolset,
  Runner,
  isFinalResponse,
  stringifyContent,
  type BaseLlm,
} from "@google/adk";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { DecisionNarrative } from "./gemini.ts";
import { parseAdkJsonResponse } from "./google-adk-runtime.ts";
import type { EvidenceKind, GrafanaWorkflowKind, GrafanaWorkflowReceipt, McpReceipt } from "../types.ts";
import { fingerprint, stableId } from "../util.ts";
import { mcpReceiptId } from "../integrity.ts";

export const GRAFANA_CLOUD_MCP_ENDPOINT = "https://mcp.grafana.com/mcp";

export interface GrafanaAdkMcpConfig {
  stackUrl: string;
  endpoint?: string;
  authProvider?: OAuthClientProvider;
}

export interface GrafanaEvidenceMission {
  experimentId: string;
  immutableVerdict: unknown;
  window: { from: string; to: string };
  localSummary: unknown;
  queryPlan: Array<{
    kind: EvidenceKind;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  workflowPlan?: Array<{
    kind: GrafanaWorkflowKind;
    toolName: string;
    args: Record<string, unknown>;
  }>;
}

export interface GrafanaEvidenceAgentResult {
  schemaVersion: "1.0";
  provenance: "grafana-mcp";
  model: string;
  serverIdentity: string;
  discoveredTools: string[];
  startedAt: string;
  completedAt: string;
  narrative: DecisionNarrative;
  receipts: McpReceipt[];
  workflowReceipts: GrafanaWorkflowReceipt[];
  calls: Array<(McpReceipt | GrafanaWorkflowReceipt) & { result: unknown }>;
}

const EVIDENCE_AGENT_INSTRUCTION = [
  "You are Greenlight's Grafana Evidence Agent for a vertical-video release gate.",
  "Use the advertised Grafana MCP tools; do not invent tool names or results.",
  "Execute every call in queryPlan and workflowPlan exactly once, using the supplied toolName and args verbatim.",
  "Call exactly one MCP tool per model turn and wait for its result before issuing the next call; never batch or parallelize tool calls on the shared MCP session.",
  "Do not call discovery tools, change expressions, add filters, or make any call outside the supplied queryPlan and workflowPlan.",
  "Correlate baseline and candidate using experiment_id, clip_id, variant, and trace IDs.",
  "The diagnosis must name localSummary.highestFailure clipId, violationPx, and traceId exactly after confirming that trace in Tempo.",
  "The deterministic verdict supplied by the operator is immutable. Never alter thresholds or the verdict.",
  "Investigate the firing alert first, then correlate metrics, logs, and traces, find the dashboard, write the supplied immutable-verdict annotation, and generate its review link.",
  "After all planned calls succeed, return JSON only with string fields diagnosis and recommendedAction.",
].join(" ");

export function createGrafanaCloudMcpToolset(config: GrafanaAdkMcpConfig): MCPToolset {
  const stackUrl = normalizeGrafanaStackUrl(config.stackUrl);
  const endpoint = normalizeMcpEndpoint(config.endpoint ?? GRAFANA_CLOUD_MCP_ENDPOINT);
  return new MCPToolset({
    type: "StreamableHTTPConnectionParams",
    url: endpoint,
    transportOptions: {
      authProvider: config.authProvider,
      requestInit: {
        headers: { "X-Grafana-URL": stackUrl },
      },
    },
  });
}

export async function runGrafanaEvidenceAgent(options: {
  model: string | BaseLlm;
  toolset: MCPToolset;
  mission: GrafanaEvidenceMission;
  serverIdentity: string;
}): Promise<GrafanaEvidenceAgentResult> {
  const startedAt = new Date().toISOString();
  const tools = await options.toolset.getTools();
  const discoveredTools = tools.map((tool) => tool.name).sort();
  const discoveredKinds = new Set(discoveredTools.map(classifyGrafanaTool).filter((kind): kind is EvidenceKind => kind !== null));
  for (const required of ["metrics", "logs", "traces"] as const) {
    if (!discoveredKinds.has(required)) throw new Error(`Grafana MCP advertised no ${required} query tool`);
  }

  const receipts: McpReceipt[] = [];
  const workflowReceipts: GrafanaWorkflowReceipt[] = [];
  const calls: Array<(McpReceipt | GrafanaWorkflowReceipt) & { result: unknown }> = [];
  const expectedCalls = new Map<string, number>();
  const plannedCalls = new Map<string, { evidenceKind?: EvidenceKind; workflowKind?: GrafanaWorkflowKind }>();
  const workflowCallsByTool = new Map<string, NonNullable<GrafanaEvidenceMission["workflowPlan"]>[number]>();
  for (const planned of options.mission.queryPlan) {
    if (!discoveredTools.includes(planned.toolName)) throw new Error(`Grafana MCP did not advertise planned tool: ${planned.toolName}`);
    if (classifyGrafanaTool(planned.toolName) !== planned.kind) throw new Error(`Grafana query plan kind does not match tool: ${planned.toolName}`);
    const key = plannedCallKey(planned.toolName, planned.args);
    expectedCalls.set(key, (expectedCalls.get(key) ?? 0) + 1);
    plannedCalls.set(key, { evidenceKind: planned.kind });
  }
  for (const planned of options.mission.workflowPlan ?? []) {
    if (!discoveredTools.includes(planned.toolName)) throw new Error(`Grafana MCP did not advertise planned workflow tool: ${planned.toolName}`);
    if (classifyGrafanaWorkflowTool(planned.toolName) !== planned.kind) {
      throw new Error(`Grafana workflow plan kind does not match tool: ${planned.toolName}`);
    }
    if (workflowCallsByTool.has(planned.toolName)) throw new Error(`Grafana workflow plan repeats tool: ${planned.toolName}`);
    workflowCallsByTool.set(planned.toolName, planned);
    const key = workflowCallKey(planned.toolName);
    expectedCalls.set(key, (expectedCalls.get(key) ?? 0) + 1);
    plannedCalls.set(key, { workflowKind: planned.kind });
  }
  for (const required of ["metrics", "logs", "traces"] as const) {
    if (!options.mission.queryPlan.some((planned) => planned.kind === required)) {
      throw new Error(`Grafana query plan has no ${required} call`);
    }
  }
  const observedCalls = new Map<string, number>();
  const attemptedCalls = new Map<string, number>();
  const successfulResponses = new Map<string, Record<string, unknown>>();
  const suppressedReplays = new Map<string, number>();
  const agent = new LlmAgent({
    name: "greenlight_grafana_evidence_agent",
    description: "Queries receipted Grafana metrics, logs, and traces before explaining a fixed release verdict",
    model: options.model,
    instruction: EVIDENCE_AGENT_INSTRUCTION,
    includeContents: "default",
    tools: [options.toolset],
    generateContentConfig: { temperature: 0 },
    beforeToolCallback: ({ tool, args }) => {
      let callKey = plannedCallKey(tool.name, args);
      const workflowCall = workflowCallsByTool.get(tool.name);
      if (!plannedCalls.has(callKey) && workflowCall) {
        const workflowKey = workflowCallKey(tool.name);
        if (workflowArgsPreserveRequiredFields(workflowCall.kind, workflowCall.args, args)
          || (workflowCall.kind === "navigation" && successfulResponses.has(workflowKey))) callKey = workflowKey;
      }
      const previous = successfulResponses.get(callKey);
      if (!previous) return undefined;
      const replayCount = (suppressedReplays.get(callKey) ?? 0) + 1;
      if (replayCount > 2) throw new Error(`Grafana Evidence Agent repeatedly requested a completed MCP call: ${tool.name}`);
      suppressedReplays.set(callKey, replayCount);
      return previous;
    },
    afterToolCallback: ({ tool, args, response }) => {
      let callKey = plannedCallKey(tool.name, args);
      let planned = plannedCalls.get(callKey);
      if (!planned) {
        const workflowCall = workflowCallsByTool.get(tool.name);
        const workflowKey = workflowCallKey(tool.name);
        if (workflowCall?.kind === "navigation" && observedCalls.has(workflowKey)) return undefined;
        if (workflowCall && (workflowArgsPreserveRequiredFields(workflowCall.kind, workflowCall.args, args)
          || (workflowCall.kind === "navigation" && successfulResponses.has(workflowKey)))) {
          callKey = workflowKey;
          planned = plannedCalls.get(callKey);
        }
      }
      if ((suppressedReplays.get(callKey) ?? 0) > 0 && observedCalls.has(callKey)) return undefined;
      if (!planned) throw new Error(`Grafana Evidence Agent called an unclassified planned tool: ${tool.name}`);
      const attempted = (attemptedCalls.get(callKey) ?? 0) + 1;
      attemptedCalls.set(callKey, attempted);
      if (attempted > 3) {
        throw new Error(`Grafana Evidence Agent exceeded the retry limit for MCP call: ${tool.name}`);
      }
      if (containsMcpError(response)) return undefined;
      const observed = (observedCalls.get(callKey) ?? 0) + 1;
      if (observed > (expectedCalls.get(callKey) ?? 0)) {
        if (planned.workflowKind === "navigation") return undefined;
        throw new Error(`Grafana Evidence Agent made an unplanned MCP call: ${tool.name}`);
      }
      observedCalls.set(callKey, observed);
      if (response && typeof response === "object" && !Array.isArray(response)) {
        successfulResponses.set(callKey, response as Record<string, unknown>);
      }
      const resultHash = fingerprint(response);
      const receiptId = mcpReceiptId({ serverIdentity: options.serverIdentity, toolName: tool.name, query: args, resultHash });
      const receivedAt = new Date().toISOString();
      if (planned.evidenceKind) {
        const receipt: McpReceipt = {
          receiptId,
          kind: planned.evidenceKind,
          serverIdentity: options.serverIdentity,
          toolName: tool.name,
          query: args,
          resultHash,
          receivedAt,
          dataPresent: grafanaResultHasData(planned.evidenceKind, response),
          traceIds: planned.evidenceKind === "traces" ? collectTraceIds(response) : undefined,
        };
        receipts.push(receipt);
        calls.push({ ...receipt, result: response });
      } else if (planned.workflowKind) {
        const receipt: GrafanaWorkflowReceipt = {
          receiptId,
          kind: planned.workflowKind,
          serverIdentity: options.serverIdentity,
          toolName: tool.name,
          input: args,
          resultHash,
          receivedAt,
          succeeded: grafanaWorkflowResultSucceeded(planned.workflowKind, response),
        };
        workflowReceipts.push(receipt);
        calls.push({ ...receipt, result: response });
      }
      return undefined;
    },
  });
  const runner = new Runner({
    appName: "greenlight",
    agent,
    sessionService: new InMemorySessionService(),
  });

  let finalText = "";
  try {
    for await (const event of runner.runEphemeral({
      userId: "greenlight-operator",
      newMessage: { role: "user", parts: [{ text: JSON.stringify(options.mission) }] },
    })) {
      if (event.errorCode || event.errorMessage) {
        throw new Error(`Grafana Evidence Agent failed: ${event.errorCode ?? "MODEL_ERROR"} ${event.errorMessage ?? ""}`.trim());
      }
      if (isFinalResponse(event)) finalText = stringifyContent(event);
    }
  } finally {
    await options.toolset.close();
  }

  const expectedTotal = options.mission.queryPlan.length + (options.mission.workflowPlan?.length ?? 0);
  if (receipts.length + workflowReceipts.length !== expectedTotal) {
    throw new Error(`Grafana Evidence Agent completed ${receipts.length + workflowReceipts.length}/${expectedTotal} planned MCP calls`);
  }
  const emptyReceipt = receipts.find((receipt) => !receipt.dataPresent);
  if (emptyReceipt) throw new Error(`Grafana Evidence Agent received empty evidence from ${emptyReceipt.toolName}`);
  for (const required of ["metrics", "logs", "traces"] as const) {
    if (!receipts.some((receipt) => receipt.kind === required && receipt.dataPresent)) {
      throw new Error(`Grafana Evidence Agent completed without non-empty ${required} MCP evidence`);
    }
  }
  const failedWorkflow = workflowReceipts.find((receipt) => !receipt.succeeded);
  if (failedWorkflow) throw new Error(`Grafana Evidence Agent workflow call did not produce the required result: ${failedWorkflow.toolName}`);
  const narrative = validateNarrative(parseAdkJsonResponse(finalText));
  const model = typeof options.model === "string" ? options.model : options.model.model;
  return {
    schemaVersion: "1.0",
    provenance: "grafana-mcp",
    model,
    serverIdentity: options.serverIdentity,
    discoveredTools,
    startedAt,
    completedAt: new Date().toISOString(),
    narrative,
    receipts,
    workflowReceipts,
    calls,
  };
}

function plannedCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${fingerprint(args)}`;
}

function workflowCallKey(toolName: string): string {
  return `workflow:${toolName}`;
}

function workflowArgsPreserveRequiredFields(kind: GrafanaWorkflowKind, expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  const required = kind === "alert"
    ? ["operation", "search_rule_name", "states"]
    : kind === "dashboard-search"
      ? ["query"]
      : kind === "annotation"
        ? ["dashboardUid", "time", "tags", "text", "data"]
        : ["resourceType", "dashboardUid"];
  return required.every((key) => key in actual && fingerprint(actual[key]) === fingerprint(expected[key]));
}

export function grafanaResultHasData(kind: EvidenceKind, value: unknown): boolean {
  let present = false;
  const visit = (item: unknown): void => {
    if (present) return;
    if (typeof item === "string" && /^[\[{]/.test(item.trim())) {
      try { visit(JSON.parse(item)); } catch { /* MCP text content is not always JSON. */ }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const resultKey = kind === "traces" ? "traces" : "data";
    if (Array.isArray(record[resultKey]) && record[resultKey].length > 0) {
      present = true;
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return present;
}

export function classifyGrafanaTool(name: string): EvidenceKind | null {
  const normalized = name.toLowerCase();
  if (normalized.includes("prometheus") || normalized.includes("promql")) return "metrics";
  if (normalized.includes("loki") || normalized.includes("logql")) return "logs";
  if (normalized.includes("tempo") || normalized.includes("traceql") || normalized.includes("trace")) return "traces";
  return null;
}

export function classifyGrafanaWorkflowTool(name: string): GrafanaWorkflowKind | null {
  if (name === "alerting_manage_rules") return "alert";
  if (name === "search_dashboards") return "dashboard-search";
  if (name === "create_annotation") return "annotation";
  if (name === "generate_deeplink") return "navigation";
  return null;
}

export function grafanaWorkflowResultSucceeded(kind: GrafanaWorkflowKind, value: unknown): boolean {
  if (containsMcpError(value)) return false;
  const strings: string[] = [];
  const keys = new Set<string>();
  let nonContentArrayItems = 0;
  const visit = (item: unknown, key = ""): void => {
    if (typeof item === "string") {
      strings.push(item);
      if (/^[\[{]/.test(item.trim())) {
        try { visit(JSON.parse(item), key); } catch { /* MCP text content is not always JSON. */ }
      }
      return;
    }
    if (Array.isArray(item)) {
      if (key !== "content") nonContentArrayItems += item.length;
      item.forEach((child) => visit(child, key));
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [childKey, child] of Object.entries(item as Record<string, unknown>)) {
      keys.add(childKey.toLowerCase());
      visit(child, childKey);
    }
  };
  visit(value);
  if (kind === "navigation") return strings.some((item) => /https?:\/\//.test(item));
  if (kind === "annotation") return keys.has("id") || strings.some((item) => /annotation/i.test(item));
  if (kind === "dashboard-search") return nonContentArrayItems > 0 && (keys.has("dashboards") || strings.some((item) => /dashboard/i.test(item)));
  return nonContentArrayItems > 0 || keys.has("rules") || strings.some((item) => /firing/i.test(item));
}

export function extractGrafanaDashboardUrl(value: unknown, expectedOrigin: string): string | null {
  const candidates: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) candidates.push(match[0]);
      if (/^[\[{]/.test(item.trim())) {
        try { visit(JSON.parse(item)); } catch { /* MCP text content is not always JSON. */ }
      }
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === expectedOrigin && (parsed.pathname.startsWith("/d/") || parsed.pathname.startsWith("/goto/"))) return parsed.toString();
    } catch { /* Ignore malformed URLs returned as prose. */ }
  }
  return null;
}

function containsMcpError(value: unknown): boolean {
  let failed = false;
  const visit = (item: unknown): void => {
    if (failed || !item || typeof item !== "object") return;
    if (Array.isArray(item)) return item.forEach(visit);
    const record = item as Record<string, unknown>;
    if (record.isError === true || record.error) {
      failed = true;
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return failed;
}

function validateNarrative(value: unknown): DecisionNarrative {
  if (!value || typeof value !== "object") throw new Error("Grafana Evidence Agent returned no narrative object");
  const item = value as Record<string, unknown>;
  if (typeof item.diagnosis !== "string" || typeof item.recommendedAction !== "string") {
    throw new Error("Grafana Evidence Agent returned an invalid narrative");
  }
  return { diagnosis: item.diagnosis, recommendedAction: item.recommendedAction };
}

export function normalizeGrafanaStackUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".grafana.net") || parsed.username || parsed.password) {
    throw new Error("GRAFANA_URL must be an https://<stack>.grafana.net URL without credentials");
  }
  return parsed.origin;
}

export function normalizeMcpEndpoint(value: string): string {
  const parsed = new URL(value);
  const localHttp = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("Grafana MCP endpoint must use HTTPS (HTTP is allowed only for local tests)");
  }
  return parsed.toString();
}

function collectTraceIds(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown, key = ""): void => {
    if (typeof item === "string") {
      if (/trace.?id/i.test(key) && /^[a-f0-9]{16,32}$/i.test(item)) found.add(item);
      for (const match of item.matchAll(/trace_?id["']?\s*[:=]\s*["']?([a-f0-9]{16,32})/ig)) found.add(match[1]);
      if (/^[\[{]/.test(item.trim())) {
        try { visit(JSON.parse(item)); } catch { /* MCP text content is not always JSON. */ }
      }
    } else if (Array.isArray(item)) item.forEach((child) => visit(child, key));
    else if (item && typeof item === "object") Object.entries(item as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value);
  return [...found].sort();
}
