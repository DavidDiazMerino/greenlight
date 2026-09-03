import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authorizeGrafanaMcp, PersistentGrafanaOAuthProvider } from "./adapters/grafana-oauth.ts";
import { fingerprint, projectRoot, writeJson } from "./util.ts";
import { GRAFANA_CLOUD_MCP_ENDPOINT, normalizeGrafanaStackUrl, normalizeMcpEndpoint } from "./adapters/grafana-adk.ts";

const FOLDER_UID = "greenlight";
const DASHBOARD_UID = "greenlight-release-gate";
const ALERT_UID = "greenlight-caption-safe-area";

interface SetupReceipt {
  toolName: string;
  input: unknown;
  resultHash: string;
  succeeded: boolean;
  receivedAt: string;
}

export async function setupGrafana(): Promise<{ capturePath: string; receipts: SetupReceipt[] }> {
  const grafanaUrl = normalizeGrafanaStackUrl(requiredEnv("GRAFANA_URL"));
  const mcpEndpoint = normalizeMcpEndpoint(process.env.GRAFANA_MCP_ENDPOINT?.trim() || GRAFANA_CLOUD_MCP_ENDPOINT);
  const provider = new PersistentGrafanaOAuthProvider();
  await authorizeGrafanaMcp({ provider, serverUrl: mcpEndpoint });

  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
    authProvider: provider,
    requestInit: { headers: { "X-Grafana-URL": grafanaUrl } },
  });
  const client = new Client({ name: "greenlight-grafana-setup", version: "0.1.0" });
  const receipts: SetupReceipt[] = [];
  const call = async (toolName: string, input: Record<string, unknown>, allowError = false): Promise<CallToolResult> => {
    const result = await client.callTool({ name: toolName, arguments: input }) as CallToolResult;
    const receipt = {
      toolName,
      input,
      resultHash: fingerprint(result),
      succeeded: result.isError !== true,
      receivedAt: new Date().toISOString(),
    };
    receipts.push(receipt);
    if (!receipt.succeeded && !allowError) throw new Error(`${toolName} failed: ${toolResultText(result)}`);
    return result;
  };

  try {
    await client.connect(transport);
    const advertised = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const required of ["search_folders", "create_folder", "update_dashboard", "search_dashboards", "alerting_manage_rules"] as const) {
      if (!advertised.has(required)) {
        throw new Error(`Grafana MCP did not advertise ${required}. Reauthorize the connection with grafana:write access.`);
      }
    }

    const folderSearch = await call("search_folders", { query: "Greenlight" });
    if (!toolResultContains(folderSearch, FOLDER_UID)) {
      await call("create_folder", { title: "Greenlight", uid: FOLDER_UID });
    }

    const dashboard = JSON.parse(await readFile(join(projectRoot, "grafana", "dashboards", "greenlight-release-gate.json"), "utf8")) as Record<string, unknown>;
    await call("update_dashboard", {
      dashboard,
      folderUid: FOLDER_UID,
      message: "Provision Greenlight release-gate dashboard from versioned source",
      overwrite: true,
    });
    const dashboardSearch = await call("search_dashboards", { query: "Greenlight Release Gate", limit: 10, page: 1 });
    if (!toolResultContains(dashboardSearch, DASHBOARD_UID)) throw new Error(`Provisioned dashboard ${DASHBOARD_UID} was not returned by Grafana search`);

    const rule = JSON.parse(await readFile(join(projectRoot, "grafana", "alert-rule-mcp.json"), "utf8")) as Record<string, unknown>;
    const existingRule = await call("alerting_manage_rules", { operation: "get", rule_uid: ALERT_UID }, true);
    await call("alerting_manage_rules", {
      ...rule,
      operation: existingRule.isError === true ? "create" : "update",
    });
    const verifiedRule = await call("alerting_manage_rules", { operation: "get", rule_uid: ALERT_UID, limit_alerts: 10 });
    if (!toolResultContains(verifiedRule, "Greenlight caption safe-area violation")) throw new Error(`Provisioned alert ${ALERT_UID} could not be verified`);

    const capturePath = join(projectRoot, "artifacts", "grafana-setup.json");
    await writeJson(capturePath, {
      schemaVersion: "1.0",
      provenance: "grafana-mcp/setup",
      grafanaStack: new URL(grafanaUrl).hostname,
      mcpEndpoint,
      completedAt: new Date().toISOString(),
      dashboardUid: DASHBOARD_UID,
      alertRuleUid: ALERT_UID,
      receipts,
    });
    return { capturePath, receipts };
  } finally {
    await client.close();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required Grafana setup setting: ${name}`);
  return value;
}

function toolResultText(result: CallToolResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join(" ").slice(0, 500);
}

function toolResultContains(result: CallToolResult, expected: string): boolean {
  return toolResultText(result).toLowerCase().includes(expected.toLowerCase())
    || JSON.stringify(result.structuredContent ?? {}).toLowerCase().includes(expected.toLowerCase());
}
