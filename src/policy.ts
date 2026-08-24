import { readFile } from "node:fs/promises";
import type { CanaryRun, DecisionVerdict, EvidenceBundle, EvidenceKind, EvidenceResilienceAssessment, GateResult, McpReceipt, Policy, PolicyDecision } from "./types.ts";
import { percentile95, round, sha256 } from "./util.ts";

function scalar(source: string, key: string): string {
  const match = source.match(new RegExp(`^\\s*${key}:\\s*([^#\\n]+)`, "m"));
  if (!match) throw new Error(`Policy field missing: ${key}`);
  return match[1].trim();
}

export async function loadPolicy(path: string): Promise<{ policy: Policy; hash: string }> {
  const source = await readFile(path, "utf8");
  const requiredEvidence = [...source.matchAll(/^\s*-\s+(metrics|logs|traces)\s*$/gm)].map((m) => m[1] as EvidenceKind);
  const rates = [...source.matchAll(/^\s+required:\s*([0-9.]+)\s*$/gm)].map((m) => Number(m[1]));
  return {
    hash: sha256(source),
    policy: {
      name: scalar(source, "name"),
      version: scalar(source, "version"),
      requiredEvidence,
      requiredRunCoverage: Number(scalar(source, "required_run_coverage")),
      safeAreaRequired: rates[0],
      outputValidityRequired: rates[1],
      p95MaxRegression: Number(scalar(source, "max_regression")),
    },
  };
}

function validMcpReceipts(receipts: McpReceipt[], required: EvidenceKind[]): boolean {
  return required.every((kind) => receipts.some((receipt) =>
    receipt.kind === kind &&
    receipt.receiptId.length > 0 &&
    receipt.serverIdentity.length > 0 &&
    receipt.toolName.length > 0 &&
    receipt.resultHash.startsWith("sha256:") &&
    (kind !== "traces" || (receipt.traceIds?.length ?? 0) >= 2)
  ));
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
    ? bundle.provenance === "grafana-mcp" && validMcpReceipts(bundle.mcpReceipts, policy.requiredEvidence)
    : bundle.provenance === "local/synthetic" && bundle.synthetic && bundle.localReceipt?.bundleHash.startsWith("sha256:") === true;
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
