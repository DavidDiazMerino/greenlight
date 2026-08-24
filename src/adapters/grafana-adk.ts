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
import type { EvidenceKind, McpReceipt } from "../types.ts";
import { fingerprint, stableId } from "../util.ts";

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
  calls: Array<McpReceipt & { result: unknown }>;
}

const EVIDENCE_AGENT_INSTRUCTION = [
  "You are Greenlight's Grafana Evidence Agent for a vertical-video release gate.",
  "Use the advertised Grafana MCP tools; do not invent tool names or results.",
  "Call at least one Prometheus query tool for metrics, one Loki query tool for logs, and one Tempo tool for traces.",
  "Scope every query to the supplied experimentId and time window whenever the tool schema permits it.",
  "Correlate baseline and candidate using experiment_id, clip_id, variant, and trace IDs.",
  "The deterministic verdict supplied by the operator is immutable. Never alter thresholds or the verdict.",
  "After the three evidence categories have been queried, return JSON only with string fields diagnosis and recommendedAction.",
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
  const calls: Array<McpReceipt & { result: unknown }> = [];
  const agent = new LlmAgent({
    name: "greenlight_grafana_evidence_agent",
    description: "Queries receipted Grafana metrics, logs, and traces before explaining a fixed release verdict",
    model: options.model,
    instruction: EVIDENCE_AGENT_INSTRUCTION,
    includeContents: "none",
    tools: [options.toolset],
    generateContentConfig: { temperature: 0 },
    afterToolCallback: ({ tool, args, response }) => {
      const kind = classifyGrafanaTool(tool.name);
      if (!kind) return undefined;
      const resultHash = fingerprint(response);
      const receipt: McpReceipt = {
        receiptId: stableId(options.serverIdentity, tool.name, JSON.stringify(args), resultHash),
        kind,
        serverIdentity: options.serverIdentity,
        toolName: tool.name,
        query: args,
        resultHash,
        receivedAt: new Date().toISOString(),
        traceIds: kind === "traces" ? collectTraceIds(response) : undefined,
      };
      receipts.push(receipt);
      calls.push({ ...receipt, result: response });
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

  for (const required of ["metrics", "logs", "traces"] as const) {
    if (!receipts.some((receipt) => receipt.kind === required)) {
      throw new Error(`Grafana Evidence Agent completed without a receipted ${required} MCP call`);
    }
  }
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
    calls,
  };
}

export function classifyGrafanaTool(name: string): EvidenceKind | null {
  const normalized = name.toLowerCase();
  if (normalized.includes("prometheus") || normalized.includes("promql")) return "metrics";
  if (normalized.includes("loki") || normalized.includes("logql")) return "logs";
  if (normalized.includes("tempo") || normalized.includes("traceql") || normalized.includes("trace")) return "traces";
  return null;
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
