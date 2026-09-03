import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyKmsSignatureEnvelope, type KmsSignatureEnvelope } from "../src/kms-envelope.ts";
import type { DecisionCard, EvidenceKind, GrafanaWorkflowKind } from "../src/types.ts";
import { projectRoot, readJson, writeJson } from "../src/util.ts";

interface SanitizedReceipt {
  kind: EvidenceKind;
  toolName: string;
  receiptId: string;
  resultHash: string;
  dataPresent: boolean;
}

interface SanitizedWorkflowReceipt {
  kind: GrafanaWorkflowKind;
  toolName: string;
  receiptId: string;
  resultHash: string;
  succeeded: boolean;
}

interface LiveVerification {
  schemaVersion: "1.0";
  verificationType: "credentialed-live-sanitized";
  verifiedAt: string;
  provenance: "grafana-mcp";
  synthetic: true;
  fixtureScope: string;
  model: string;
  mcpEndpoint: string;
  experimentId: string;
  grafanaDashboardUrl: string;
  narrative: { diagnosis: string; recommendedAction: string };
  rootCause: { clipId: string; violationPx: number; traceId: string; traceConfirmedByTempo: boolean };
  decision: {
    verdict: string;
    reason: string;
    policyOwner: "deterministic-policy-evaluator";
    policyHash: string;
    verdictChangedByAgent: false;
    candidateFailures: number;
    maximumViolationPx: number;
    decisionReceiptFingerprint: string;
    mcpPolicyReevaluation: { decision: string; reason: string; rawProofsRehashed: number; matchesLocalVerdict: true };
  };
  evidenceReceipts: SanitizedReceipt[];
  workflowReceipts: SanitizedWorkflowReceipt[];
}

const verificationPath = join(projectRoot, "docs", "verification", "live-alert-dashboard-mcp-2026-09-03.json");
const envelopePath = join(projectRoot, "docs", "verification", "kms-decision-receipt-signature.json");
const latest = join(projectRoot, "artifacts", "latest");
const cardPath = join(latest, "decision-card.json");
const verification = await readJson<LiveVerification>(verificationPath);
const card = await readJson<DecisionCard>(cardPath);
const envelope = await readJson<KmsSignatureEnvelope>(envelopePath);
const publicKeyPem = await readFile(join(projectRoot, envelope.key.publicKeyPath), "utf8");
const kmsVerification = verifyKmsSignatureEnvelope(envelope, publicKeyPem);

if (verification.verificationType !== "credentialed-live-sanitized" || verification.provenance !== "grafana-mcp") {
  throw new Error("Public deployment requires a credentialed, sanitized Grafana MCP verification record");
}
if (!verification.synthetic || !verification.fixtureScope.startsWith("local/synthetic")) {
  throw new Error("Live verification must retain local/synthetic fixture disclosure");
}
if (verification.experimentId !== card.experimentId || verification.decision.verdict !== card.decision) {
  throw new Error("Live verification does not bind to the generated experiment and deterministic verdict");
}
if (verification.decision.reason !== card.reason || verification.decision.policyHash !== card.policyHash) {
  throw new Error("Live verification does not bind to the generated policy result");
}
if (verification.decision.decisionReceiptFingerprint !== card.decisionReceiptFingerprint) {
  throw new Error("Live verification does not bind to the generated Decision Receipt");
}
if (!verification.rootCause.traceConfirmedByTempo || !verification.decision.mcpPolicyReevaluation.matchesLocalVerdict) {
  throw new Error("Live verification lacks exact trace correlation or matching MCP policy re-evaluation");
}
if (verification.decision.policyOwner !== card.policyOwner || verification.decision.verdictChangedByAgent !== false) {
  throw new Error("Live verification does not preserve deterministic policy ownership");
}
if (verification.decision.candidateFailures !== card.affectedAssets.length) {
  throw new Error("Live verification candidate-failure count differs from the generated card");
}
if (verification.evidenceReceipts.length !== 4 || verification.workflowReceipts.length !== 4) {
  throw new Error("Public deployment requires four evidence and four workflow receipts");
}
for (const kind of ["metrics", "logs", "traces"] as const) {
  if (!verification.evidenceReceipts.some((receipt) => receipt.kind === kind && receipt.dataPresent)) {
    throw new Error(`Live verification has no non-empty ${kind} receipt`);
  }
}
for (const kind of ["alert", "dashboard-search", "annotation", "navigation"] as const) {
  if (!verification.workflowReceipts.some((receipt) => receipt.kind === kind && receipt.succeeded)) {
    throw new Error(`Live verification has no successful ${kind} receipt`);
  }
}
const dashboardUrl = new URL(verification.grafanaDashboardUrl);
if (dashboardUrl.protocol !== "https:" || !dashboardUrl.hostname.endsWith(".grafana.net") || !dashboardUrl.pathname.startsWith("/d/")) {
  throw new Error("Live verification dashboard URL is not a valid Grafana dashboard link");
}
if (!kmsVerification.valid) throw new Error(`Cloud KMS signature verification failed: ${JSON.stringify(kmsVerification.checks)}`);
if (envelope.payload.experimentId !== card.experimentId || envelope.payload.decisionReceipt.fingerprint !== card.decisionReceiptFingerprint) {
  throw new Error("Cloud KMS signature does not bind to the public Decision Card");
}

const publicCard: DecisionCard = {
  ...card,
  diagnosis: verification.narrative.diagnosis,
  recommendedAction: verification.narrative.recommendedAction,
  mcpReceipts: verification.evidenceReceipts.map((receipt) => ({
    ...receipt,
    serverIdentity: verification.mcpEndpoint,
  })),
  grafanaWorkflowReceipts: verification.workflowReceipts.map((receipt) => ({
    ...receipt,
    serverIdentity: verification.mcpEndpoint,
  })),
  grafanaEvidenceRefs: ["/artifacts/latest/live-verification.json"],
  grafanaDashboardUrl: verification.grafanaDashboardUrl,
  geminiModel: verification.model,
  replayCommand: "make agent-live",
  liveVerification: {
    status: "credentialed-live-sanitized",
    verifiedAt: verification.verifiedAt,
    source: "/artifacts/latest/live-verification.json",
    decisionReceiptFingerprint: verification.decision.decisionReceiptFingerprint,
    note: "Local/synthetic media fixture; real Vertex AI, OTLP, and Grafana MCP execution verified separately.",
  },
  kmsVerification: {
    status: "verified-cloud-kms-signature",
    signedAt: envelope.payload.signedAt,
    source: "/artifacts/latest/kms-signature.json",
    keyResource: envelope.key.resource,
    publicKeyPath: "/artifacts/latest/decision-receipt-public-key.pem",
    signatureFingerprint: envelope.fingerprint,
    decisionReceiptFingerprint: envelope.payload.decisionReceipt.fingerprint,
  },
};

await writeJson(cardPath, publicCard);
await copyFile(verificationPath, join(latest, "live-verification.json"));
await copyFile(envelopePath, join(latest, "kms-signature.json"));
await copyFile(join(projectRoot, envelope.key.publicKeyPath), join(latest, "decision-receipt-public-key.pem"));
process.stdout.write(`Applied sanitized live verification to public Decision Card: ${cardPath}\n`);
