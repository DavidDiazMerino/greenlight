import { readFile } from "node:fs/promises";
import type { CanaryRun, DecisionVerdict, EvidenceBundle, EvidenceKind, EvidenceResilienceAssessment, GateResult, McpReceipt, Policy, PolicyDecision } from "./types.ts";
import { parse } from "yaml";
import { localEvidenceFingerprint, verifyMcpReceipt } from "./integrity.ts";
import { percentile95, round, sha256 } from "./util.ts";

export const TRUSTED_POLICY_HASH = "sha256:6a909329bd4c0312ddf1dd7faeb455123439a2ae5101aaae490c8c8487494673";

export async function loadPolicy(path: string, expectedHash: string | null = TRUSTED_POLICY_HASH): Promise<{ policy: Policy; hash: string }> {
  const source = await readFile(path, "utf8");
  const hash = sha256(source);
  if (expectedHash && hash !== expectedHash) throw new Error(`Policy trust check failed: expected ${expectedHash}, received ${hash}`);
  const document = parse(source) as Record<string, unknown>;
  const requiredEvidence = document.required_evidence;
  const gates = document.gates as Record<string, Record<string, unknown>> | undefined;
  if (!Array.isArray(requiredEvidence) || !requiredEvidence.every((item) => ["metrics", "logs", "traces"].includes(String(item)))) {
    throw new Error("Policy required_evidence must contain only metrics, logs, and traces");
  }
  const number = (value: unknown, field: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Policy field must be numeric: ${field}`);
    return parsed;
  };
  if (!gates) throw new Error("Policy gates are missing");
  return {
    hash,
    policy: {
      name: String(document.name ?? ""),
      version: String(document.version ?? ""),
      requiredEvidence: requiredEvidence as EvidenceKind[],
      requiredRunCoverage: number(document.required_run_coverage, "required_run_coverage"),
      safeAreaRequired: number(gates.caption_safe_area_pass_rate?.required, "gates.caption_safe_area_pass_rate.required"),
      outputValidityRequired: number(gates.output_validity_pass_rate?.required, "gates.output_validity_pass_rate.required"),
      p95MaxRegression: number(gates.p95_render_duration?.max_regression, "gates.p95_render_duration.max_regression"),
    },
  };
}

function validMcpReceipts(bundle: EvidenceBundle, required: EvidenceKind[]): boolean {
  const receipts = bundle.mcpReceipts;
  const proofs = bundle.mcpProofs ?? [];
  const validByKind = required.every((kind) => receipts.some((receipt) =>
    receipt.kind === kind &&
    receipt.receiptId.length > 0 &&
    receipt.serverIdentity.length > 0 &&
    receipt.toolName.length > 0 &&
    verifyMcpReceipt(receipt, proofs)
  ));
  const pairedTraceIds = new Set(receipts.filter((receipt) => receipt.kind === "traces").flatMap((receipt) => receipt.traceIds ?? []));
  return validByKind && (!required.includes("traces") || pairedTraceIds.size >= 2);
}

export function evaluatePolicy(
  bundle: EvidenceBundle,
  policy: Policy,
  options: {
    requireMcp: boolean;
    resilience?: EvidenceResilienceAssessment;
    canaryRun?: CanaryRun;
    suggestedAction?: DecisionVerdict;
  } = { requireMcp: false },
): PolicyDecision {
  const present = new Set(bundle.evidencePresent);
  const evidenceData = { metrics: bundle.metrics, logs: bundle.logs, traces: bundle.traces };
  const baseEvidenceComplete = policy.requiredEvidence.every((kind) => present.has(kind) && evidenceData[kind].length > 0);
  const failedClipIds = new Set(bundle.metrics.filter((metric) => !metric.safeAreaPass || !metric.outputValid).map((metric) => `${metric.variant}:${metric.clipId}`));
  const failedLogsComplete = [...failedClipIds].every((key) => bundle.logs.some((log) => `${log.variant}:${log.clip_id}` === key));
  const provenanceComplete = options.requireMcp
    ? bundle.provenance === "grafana-mcp" && validMcpReceipts(bundle, policy.requiredEvidence)
    : bundle.provenance === "local/synthetic" && bundle.synthetic && bundle.localReceipt?.bundleHash === localEvidenceFingerprint(bundle);
  const baseline = bundle.metrics.filter((m) => m.variant === "baseline" && m.runCompleted);
  const candidate = bundle.metrics.filter((m) => m.variant === "candidate" && m.runCompleted);
  const coverage = baseline.length + candidate.length;
  const coverageComplete = coverage >= policy.requiredRunCoverage;

  if (!baseEvidenceComplete || !failedLogsComplete || !provenanceComplete || !coverageComplete) {
    return {
      decision: "HOLD",
      reason: "INSUFFICIENT_EVIDENCE",
      deploymentBlocked: true,
      evidenceCompleteness: options.requireMcp
        ? "HOLD — INSUFFICIENT EVIDENCE (valid Grafana MCP metric, log, and trace receipts required)"
        : `HOLD — INSUFFICIENT EVIDENCE (${coverage}/${policy.requiredRunCoverage} local runs)`,
      runCoverage: coverage,
      gates: [],
      blockingInvariantIds: [],
    };
  }

  const rate = (items: typeof baseline, key: "safeAreaPass" | "outputValid") =>
    items.filter((item) => item[key]).length / items.length;
  const baselineSafe = rate(baseline, "safeAreaPass");
  const candidateSafe = rate(candidate, "safeAreaPass");
  const baselineValid = rate(baseline, "outputValid");
  const candidateValid = rate(candidate, "outputValid");
  const baselineP95 = percentile95(baseline.map((m) => m.renderDurationMs));
  const candidateP95 = percentile95(candidate.map((m) => m.renderDurationMs));
  const renderRegression = baselineP95 === 0 ? 0 : (candidateP95 - baselineP95) / baselineP95;
  const gates: GateResult[] = [
    {
      metric: "caption_safe_area_pass_rate",
      baseline: round(baselineSafe), candidate: round(candidateSafe), delta: round(candidateSafe - baselineSafe),
      threshold: `required = ${policy.safeAreaRequired}`, severity: "hard", pass: candidateSafe >= policy.safeAreaRequired, unit: "rate",
    },
    {
      metric: "output_validity_pass_rate",
      baseline: round(baselineValid), candidate: round(candidateValid), delta: round(candidateValid - baselineValid),
      threshold: `required = ${policy.outputValidityRequired}`, severity: "hard", pass: candidateValid >= policy.outputValidityRequired, unit: "rate",
    },
    {
      metric: "p95_render_duration",
      baseline: round(baselineP95, 1), candidate: round(candidateP95, 1), delta: round(renderRegression),
      threshold: `max regression = ${policy.p95MaxRegression}`, severity: "soft", pass: renderRegression <= policy.p95MaxRegression, unit: "ms",
    },
    {
      metric: "run_coverage",
      baseline: baseline.length, candidate: candidate.length, delta: 0,
      threshold: `required = ${policy.requiredRunCoverage}`, severity: "hard", pass: coverageComplete, unit: "runs",
    },
  ];

  if (!gates[1].pass) {
    return { decision: "REJECT", reason: "INVALID_OUTPUT", deploymentBlocked: true, evidenceCompleteness: `${coverage}/${policy.requiredRunCoverage} runs · metrics + logs + traces`, runCoverage: coverage, gates, blockingInvariantIds: options.canaryRun?.blockingFailures ?? [] };
  }
  const blockingInvariantIds = options.canaryRun?.blockingFailures ?? [];
  if (gates.some((gate) => gate.severity === "hard" && !gate.pass) || blockingInvariantIds.length > 0) {
    return { decision: "HOLD", reason: "GATE_FAILED", deploymentBlocked: true, evidenceCompleteness: `${coverage}/${policy.requiredRunCoverage} runs · metrics + logs + traces`, runCoverage: coverage, gates, blockingInvariantIds };
  }
  if (options.resilience?.recommendationEligible !== true) {
    return {
      decision: "HOLD",
      reason: "INSUFFICIENT_EVIDENCE",
      deploymentBlocked: true,
      evidenceCompleteness: `${coverage}/${policy.requiredRunCoverage} runs · metrics + logs + traces · recommendation suppressed`,
      runCoverage: coverage,
      gates,
      blockingInvariantIds,
    };
  }
  return { decision: "PROMOTE", reason: "POLICY_PASSED", deploymentBlocked: false, evidenceCompleteness: `${coverage}/${policy.requiredRunCoverage} runs · metrics + logs + traces`, runCoverage: coverage, gates, blockingInvariantIds };
}
