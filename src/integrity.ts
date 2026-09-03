import type { EvidenceBundle, McpEvidenceProof, McpReceipt } from "./types.ts";
import { fingerprint, stableId } from "./util.ts";

export function localEvidencePayload(bundle: Pick<EvidenceBundle, "experimentId" | "metrics" | "logs" | "traces" | "toolchain">) {
  return {
    experimentId: bundle.experimentId,
    metrics: bundle.metrics,
    logs: bundle.logs,
    traces: bundle.traces,
    toolchain: bundle.toolchain,
  };
}

export function localEvidenceFingerprint(bundle: Pick<EvidenceBundle, "experimentId" | "metrics" | "logs" | "traces" | "toolchain">): string {
  return fingerprint(localEvidencePayload(bundle));
}

export function isSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

export function mcpReceiptId(receipt: Pick<McpReceipt, "serverIdentity" | "toolName" | "query" | "resultHash">): string {
  return stableId(receipt.serverIdentity, receipt.toolName, JSON.stringify(receipt.query), receipt.resultHash);
}

export function verifyMcpReceipt(receipt: McpReceipt, proofs: McpEvidenceProof[]): boolean {
  if (!isSha256(receipt.resultHash) || receipt.dataPresent !== true || !receipt.query) return false;
  if (receipt.receiptId !== mcpReceiptId(receipt)) return false;
  const proof = proofs.find((item) => item.receiptId === receipt.receiptId);
  if (!proof || fingerprint(proof.result) !== receipt.resultHash) return false;
  if (receipt.kind !== "traces") return true;
  const resultTraceIds = collectTraceIds(proof.result);
  return (receipt.traceIds?.length ?? 0) > 0 && receipt.traceIds!.every((traceId) => resultTraceIds.has(traceId));
}

function collectTraceIds(value: unknown): Set<string> {
  const result = new Set<string>();
  const visit = (item: unknown, key = ""): void => {
    if (typeof item === "string") {
      if (/trace.?id/i.test(key) && /^[a-f0-9]{16,32}$/i.test(item)) result.add(item);
      for (const match of item.matchAll(/trace_?id["']?\s*[:=]\s*["']?([a-f0-9]{16,32})/ig)) result.add(match[1]);
      if (/^[\[{]/.test(item.trim())) {
        try { visit(JSON.parse(item), key); } catch { /* Text content is not always JSON. */ }
      }
      return;
    }
    if (Array.isArray(item)) return item.forEach((child) => visit(child, key));
    if (item && typeof item === "object") {
      Object.entries(item as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(value);
  return result;
}
