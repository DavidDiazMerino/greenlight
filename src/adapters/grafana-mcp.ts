import type { EvidenceKind, McpReceipt } from "../types.ts";
import { sha256, stableId } from "../util.ts";

export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpTransport {
  readonly serverIdentity: string;
  listTools(): Promise<DiscoveredMcpTool[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
}

export interface GrafanaToolBinding {
  metrics: string;
  logs: string;
  traces: string;
}

/**
 * Honest Grafana MCP boundary. Tool names are never guessed: callers inspect
 * listTools(), bind names actually advertised by their server, then queries are
 * receipted with the exact tool, input, result hash, and server identity.
 */
export class GrafanaMcpAdapter {
  private readonly transport: McpTransport;
  constructor(transport: McpTransport) {
    this.transport = transport;
  }

  discoverCapabilities(): Promise<DiscoveredMcpTool[]> {
    return this.transport.listTools();
  }

  async query(kind: EvidenceKind, binding: GrafanaToolBinding, input: unknown, traceIds?: string[]): Promise<{ result: unknown; receipt: McpReceipt }> {
    const toolName = binding[kind];
    if (!toolName) throw new Error(`No discovered Grafana MCP binding for ${kind}`);
    const advertised = await this.transport.listTools();
    if (!advertised.some((tool) => tool.name === toolName)) throw new Error(`Grafana MCP did not advertise configured tool: ${toolName}`);
    const result = await this.transport.callTool(toolName, input);
    const resultHash = sha256(JSON.stringify(result));
    return {
      result,
      receipt: {
        receiptId: stableId(this.transport.serverIdentity, toolName, JSON.stringify(input), resultHash),
        kind,
        serverIdentity: this.transport.serverIdentity,
        toolName,
        query: input,
        resultHash,
        receivedAt: new Date().toISOString(),
        traceIds,
      },
    };
  }
}
