import { join } from "node:path";
import type { DecisionCard, EvidenceBundle } from "../src/types.ts";
import type { GrafanaEvidenceAgentResult } from "../src/adapters/grafana-adk.ts";
import { projectRoot, readJson, writeJson } from "../src/util.ts";

interface LiveCapture extends GrafanaEvidenceAgentResult {
  decisionBinding: {
    owner: "deterministic-policy-evaluator";
    immutableDecisionReceiptFingerprint: string;
    verdictChangedByAgent: false;
    mcpPolicyReevaluation: {
      decision: string;
      reason: string;
      rawProofsRehashed: number;
      matchesLocalVerdict: true;
    };
  };
}

const latest = join(projectRoot, "artifacts", "latest");
const capture = await readJson<LiveCapture>(join(latest, "grafana-adk-run.json"));
const card = await readJson<DecisionCard>(join(latest, "decision-card.json"));
const evidence = await readJson<EvidenceBundle>(join(latest, "evidence-bundle.json"));
const highestFailure = evidence.metrics
  .filter((item) => item.variant === "candidate" && !item.safeAreaPass)
  .sort((left, right) => right.violationPx - left.violationPx || left.clipId.localeCompare(right.clipId))[0];

if (!highestFailure) throw new Error("Cannot sanitize a live run without a candidate failure");
if (capture.provenance !== "grafana-mcp" || capture.decisionBinding.owner !== "deterministic-policy-evaluator") {
  throw new Error("Raw capture does not preserve the expected Grafana MCP and policy provenance");
}
if (capture.decisionBinding.immutableDecisionReceiptFingerprint !== card.decisionReceiptFingerprint) {
  throw new Error("Raw live capture and Decision Card receipt fingerprints differ");
}
if (!capture.decisionBinding.mcpPolicyReevaluation.matchesLocalVerdict || capture.decisionBinding.verdictChangedByAgent) {
  throw new Error("Raw live capture does not prove a matching deterministic re-evaluation");
}
for (const exact of [highestFailure.clipId, String(highestFailure.violationPx), highestFailure.traceId]) {
  if (!capture.narrative.diagnosis.includes(exact)) throw new Error(`Diagnosis omits exact root-cause value: ${exact}`);
}

const record = {
  schemaVersion: "1.0",
  verificationType: "credentialed-live-sanitized",
  verifiedAt: capture.completedAt,
  provenance: "grafana-mcp",
  synthetic: true,
  fixtureScope: "local/synthetic canary exported to a real Grafana Cloud stack",
  model: capture.model,
  mcpEndpoint: new URL(capture.serverIdentity.split("#")[0]).origin + "/mcp",
  discoveredToolCount: capture.discoveredTools.length,
  experimentId: card.experimentId,
  grafanaDashboardUrl: card.grafanaDashboardUrl,
  narrative: capture.narrative,
  rootCause: {
    clipId: highestFailure.clipId,
    violationPx: highestFailure.violationPx,
    traceId: highestFailure.traceId,
    traceConfirmedByTempo: capture.receipts.some((item) => item.kind === "traces" && item.traceIds?.includes(highestFailure.traceId)),
  },
  decision: {
    verdict: card.decision,
    reason: card.reason,
    policyOwner: card.policyOwner,
    policyHash: card.policyHash,
    verdictChangedByAgent: false,
    candidateFailures: card.affectedAssets.length,
    maximumViolationPx: Math.max(...evidence.metrics.map((item) => item.violationPx)),
    decisionReceiptFingerprint: card.decisionReceiptFingerprint,
    mcpPolicyReevaluation: capture.decisionBinding.mcpPolicyReevaluation,
  },
  evidenceReceipts: capture.receipts.map(({ kind, toolName, receiptId, resultHash, dataPresent, traceIds }) => ({
    kind, toolName, receiptId, resultHash, dataPresent, returnedTraceIds: traceIds?.length,
  })),
  workflowReceipts: capture.workflowReceipts.map(({ kind, toolName, receiptId, resultHash, succeeded }) => ({
    kind, toolName, receiptId, resultHash, succeeded,
  })),
  sanitization: {
    rawMcpResultsIncluded: false,
    oauthTokensIncluded: false,
    otlpHeadersIncluded: false,
    googleCredentialsIncluded: false,
  },
};

const output = join(projectRoot, "docs", "verification", "live-alert-dashboard-mcp-2026-09-03.json");
await writeJson(output, record);
process.stdout.write(`Sanitized credentialed live capture: ${output}\n`);
