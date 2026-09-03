import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { BaseLlm, getLogger, setLogger, type BaseLlmConnection, type LlmResponse } from "@google/adk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { classifyGrafanaTool, classifyGrafanaWorkflowTool, createGrafanaCloudMcpToolset, extractGrafanaDashboardUrl, grafanaResultHasData, grafanaWorkflowResultSucceeded, runGrafanaEvidenceAgent } from "../src/adapters/grafana-adk.ts";

const toolNames = ["query_prometheus", "query_loki_logs", "tempo_traceql_search"];
const workflowCalls = [
  { kind: "alert" as const, toolName: "alerting_manage_rules", args: { operation: "list", search_rule_name: "Greenlight caption safe-area violation", states: ["firing"], rule_limit: 10 } },
  { kind: "dashboard-search" as const, toolName: "search_dashboards", args: { query: "Greenlight Release Gate", limit: 10, page: 1 } },
  { kind: "annotation" as const, toolName: "create_annotation", args: { dashboardUid: "greenlight-release-gate", time: 1788370000000, tags: ["greenlight"], text: "HOLD", data: { fingerprint: "sha256:test" } } },
  { kind: "navigation" as const, toolName: "generate_deeplink", args: { resourceType: "dashboard", dashboardUid: "greenlight-release-gate", timeRange: { from: "now-5m", to: "now" }, queryParams: { "var-experiment_id": "exp-test" }, shorten: false } },
];
const advertisedToolNames = [...toolNames, ...workflowCalls.map((call) => call.toolName)];
const baselineTraceId = "0123456789abcdef0123456789abcdef";
const candidateTraceId = "fedcba9876543210fedcba9876543210";

class ToolCallingModel extends BaseLlm {
  private round = 0;
  constructor() {
    super({ model: "greenlight-grafana-tool-test-model" });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    if (this.round++ === 0) {
      yield {
        content: {
          role: "model",
          parts: toolNames.map((name, index) => ({
            functionCall: { id: `call-${index}`, name, args: { query: `experiment_id=exp-test kind=${name}` } },
          })),
        },
      };
      return;
    }
    yield {
      content: {
        role: "model",
        parts: [{ text: JSON.stringify({ diagnosis: "The candidate crosses the safe area.", recommendedAction: "Fix and replay." }) }],
      },
    };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("Live connections are outside this deterministic test");
  }
}

class WorkflowToolCallingModel extends BaseLlm {
  private round = 0;
  constructor() {
    super({ model: "greenlight-grafana-workflow-test-model" });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    if (this.round++ === 0) {
      yield {
        content: {
          role: "model",
          parts: [
            ...toolNames.map((name, index) => ({
              functionCall: { id: `evidence-${index}`, name, args: { query: `experiment_id=exp-test kind=${name}` } },
            })),
            ...workflowCalls.map((call, index) => ({
              functionCall: { id: `workflow-${index}`, name: call.toolName, args: Object.fromEntries(Object.entries(call.args).filter(([key]) => !["rule_limit", "limit", "page", "shorten"].includes(key))) },
            })),
          ],
        },
      };
      return;
    }
    yield {
      content: {
        role: "model",
        parts: [{ text: JSON.stringify({ diagnosis: "The firing alert matches the pixel regression.", recommendedAction: "Fix and replay." }) }],
      },
    };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("Live connections are outside this deterministic test");
  }
}

function fakeGrafanaServer() {
  let routedStack = "";
  const httpServer = createServer(async (request, response) => {
    routedStack = String(request.headers["x-grafana-url"] ?? "");
    const server = new Server({ name: "greenlight-test-grafana", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: advertisedToolNames.map((name) => ({
        name,
        description: `Test ${name}`,
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const payload = name.includes("tempo")
        ? { traces: [{ traceID: baselineTraceId, nested: { traceId: candidateTraceId } }], query: request.params.arguments }
        : name === "alerting_manage_rules"
          ? { rules: [{ title: "Greenlight caption safe-area violation", state: "firing" }] }
          : name === "search_dashboards"
            ? { dashboards: [{ uid: "greenlight-release-gate", title: "Greenlight Release Gate" }] }
            : name === "create_annotation"
              ? { id: 42, message: "Annotation added" }
              : name === "generate_deeplink"
                ? "https://greenlight-test.grafana.net/d/greenlight-release-gate"
                : { data: [{ rows: 1 }], query: request.params.arguments };
      return {
        content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
        structuredContent: typeof payload === "object" ? payload : undefined,
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response);
  });
  return {
    httpServer,
    routedStack: () => routedStack,
  };
}

test("Google ADK discovers and calls metric, log, and trace tools through Streamable HTTP MCP", async () => {
  const previousLogger = getLogger();
  setLogger(null);
  const fake = fakeGrafanaServer();
  fake.httpServer.listen(0, "127.0.0.1");
  await once(fake.httpServer, "listening");
  const address = fake.httpServer.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const toolset = createGrafanaCloudMcpToolset({ stackUrl: "https://greenlight-test.grafana.net", endpoint });

  try {
    const result = await runGrafanaEvidenceAgent({
      model: new ToolCallingModel(),
      toolset,
      serverIdentity: `${endpoint}#greenlight-test.grafana.net`,
      mission: {
        experimentId: "exp-test",
        immutableVerdict: { decision: "HOLD" },
        window: { from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T00:05:00.000Z" },
        localSummary: { candidateFailures: 5 },
        queryPlan: toolNames.map((toolName) => ({
          kind: classifyGrafanaTool(toolName)!,
          toolName,
          args: { query: `experiment_id=exp-test kind=${toolName}` },
        })),
      },
    });
    assert.deepEqual(result.receipts.map((receipt) => receipt.kind).sort(), ["logs", "metrics", "traces"]);
    assert.ok(result.receipts.every((receipt) => receipt.dataPresent));
    assert.deepEqual(result.receipts.find((receipt) => receipt.kind === "traces")?.traceIds, [baselineTraceId, candidateTraceId].sort());
    assert.equal(result.narrative.diagnosis, "The candidate crosses the safe area.");
    assert.equal(fake.routedStack(), "https://greenlight-test.grafana.net");
  } finally {
    fake.httpServer.close();
    await once(fake.httpServer, "close");
    setLogger(previousLogger);
  }
});

test("Google ADK executes a receipted alert-to-dashboard workflow without mixing operational receipts into evidence", async () => {
  const previousLogger = getLogger();
  setLogger(null);
  const fake = fakeGrafanaServer();
  fake.httpServer.listen(0, "127.0.0.1");
  await once(fake.httpServer, "listening");
  const address = fake.httpServer.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const toolset = createGrafanaCloudMcpToolset({ stackUrl: "https://greenlight-test.grafana.net", endpoint });

  try {
    const result = await runGrafanaEvidenceAgent({
      model: new WorkflowToolCallingModel(),
      toolset,
      serverIdentity: `${endpoint}#greenlight-test.grafana.net`,
      mission: {
        experimentId: "exp-test",
        immutableVerdict: { decision: "HOLD" },
        window: { from: "2026-08-24T00:00:00.000Z", to: "2026-08-24T00:05:00.000Z" },
        localSummary: { candidateFailures: 5 },
        queryPlan: toolNames.map((toolName) => ({
          kind: classifyGrafanaTool(toolName)!,
          toolName,
          args: { query: `experiment_id=exp-test kind=${toolName}` },
        })),
        workflowPlan: workflowCalls,
      },
    });
    assert.equal(result.receipts.length, 3);
    assert.equal(result.workflowReceipts.length, 4);
    assert.deepEqual(result.workflowReceipts.map((receipt) => receipt.kind), ["alert", "dashboard-search", "annotation", "navigation"]);
    assert.ok(result.workflowReceipts.every((receipt) => receipt.succeeded));
    assert.ok(result.receipts.every((receipt) => ["metrics", "logs", "traces"].includes(receipt.kind)));
  } finally {
    fake.httpServer.close();
    await once(fake.httpServer, "close");
    setLogger(previousLogger);
  }
});

test("Grafana MCP tool classification is explicit and unknown tools stay unreceipted", () => {
  assert.equal(classifyGrafanaTool("query_prometheus"), "metrics");
  assert.equal(classifyGrafanaTool("query_loki_logs"), "logs");
  assert.equal(classifyGrafanaTool("tempo_get_trace"), "traces");
  assert.equal(classifyGrafanaTool("generate_deeplink"), null);
  assert.equal(classifyGrafanaWorkflowTool("alerting_manage_rules"), "alert");
  assert.equal(classifyGrafanaWorkflowTool("search_dashboards"), "dashboard-search");
  assert.equal(classifyGrafanaWorkflowTool("create_annotation"), "annotation");
  assert.equal(classifyGrafanaWorkflowTool("generate_deeplink"), "navigation");
  assert.equal(classifyGrafanaWorkflowTool("update_dashboard"), null);
});

test("Grafana evidence only counts non-empty backend result arrays", () => {
  assert.equal(grafanaResultHasData("metrics", { content: [{ text: '{"data":[{"values":[[1,"2"]]}]}' }] }), true);
  assert.equal(grafanaResultHasData("logs", { content: [{ text: '{"data":[]}' }] }), false);
  assert.equal(grafanaResultHasData("traces", { content: [{ text: '{"traces":[{"traceID":"abc"}]}' }] }), true);
  assert.equal(grafanaResultHasData("traces", { content: [{ text: '{"traces":[]}' }] }), false);
});

test("Grafana workflow validation requires semantic results and a same-stack dashboard link", () => {
  assert.equal(grafanaWorkflowResultSucceeded("alert", { content: [{ text: '{"rules":[{"title":"Greenlight","state":"firing"}]}' }] }), true);
  assert.equal(grafanaWorkflowResultSucceeded("dashboard-search", { dashboards: [{ uid: "greenlight-release-gate" }] }), true);
  assert.equal(grafanaWorkflowResultSucceeded("annotation", { id: 42, message: "Annotation added" }), true);
  assert.equal(grafanaWorkflowResultSucceeded("navigation", { content: [{ text: "https://greenlight-test.grafana.net/d/greenlight-release-gate" }] }), true);
  assert.equal(grafanaWorkflowResultSucceeded("annotation", { isError: true, error: "forbidden" }), false);
  assert.equal(
    extractGrafanaDashboardUrl({ content: [{ text: "Open https://greenlight-test.grafana.net/d/greenlight-release-gate?var=x" }] }, "https://greenlight-test.grafana.net"),
    "https://greenlight-test.grafana.net/d/greenlight-release-gate?var=x",
  );
  assert.equal(
    extractGrafanaDashboardUrl("https://attacker.example/d/greenlight-release-gate", "https://greenlight-test.grafana.net"),
    null,
  );
});

test("Grafana stack routing rejects non-Grafana and credential-bearing URLs", () => {
  assert.throws(() => createGrafanaCloudMcpToolset({ stackUrl: "https://example.com" }), /GRAFANA_URL/);
  assert.throws(() => createGrafanaCloudMcpToolset({ stackUrl: "https://user:secret@stack.grafana.net" }), /GRAFANA_URL/);
});
