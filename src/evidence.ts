import type {
  CanaryPack,
  CanaryRun,
  Change,
  ConfidenceComponent,
  Dataset,
  DecisionCard,
  DecisionOutcome,
  DecisionReceipt,
  DecisionVerdict,
  EvidenceCasefile,
  EvidenceItem,
  EvidenceResilienceAssessment,
  GateResult,
  Invariant,
  Signal,
} from "./types.ts";
import { fingerprint, round, stableId } from "./util.ts";

export function fingerprintEvidenceItems(items: EvidenceItem[]): string {
  return fingerprint([...items].sort((left, right) => left.id.localeCompare(right.id)));
}

export function createEvidenceItem(input: Omit<EvidenceItem, "schemaVersion" | "id" | "contentFingerprint"> & { idHint: string }): EvidenceItem {
  const { idHint, ...content } = input;
  const contentFingerprint = fingerprint(content);
  return {
    schemaVersion: "1.0",
    id: `evidence:${stableId(idHint, contentFingerprint).slice(0, 16)}`,
    ...content,
    contentFingerprint,
  };
}

export function createSignal(input: {
  change: Change;
  kind: Signal["kind"];
  affectedAssets: string[];
  evidence: EvidenceItem[];
  confidenceComponents: ConfidenceComponent[];
  confidenceVersion: string;
}): Signal {
  const evidence = [...input.evidence].sort((left, right) => left.id.localeCompare(right.id));
  const evidenceFingerprint = fingerprintEvidenceItems(evidence);
  const confidence = round(Math.max(0, Math.min(1, input.confidenceComponents.reduce((total, component) => total + component.value, 0))), 3);
  return {
    schemaVersion: "1.0",
    id: `signal:${stableId(input.change.id, input.kind, evidenceFingerprint).slice(0, 16)}`,
    changeId: input.change.id,
    affectedComponent: input.change.component,
    kind: input.kind,
    affectedAssets: [...input.affectedAssets].sort(),
    evidenceIds: evidence.map((item) => item.id),
    confidence,
    confidenceVersion: input.confidenceVersion,
    confidenceComponents: input.confidenceComponents,
    evidenceFingerprint,
    status: evidence.length > 0 ? "validated" : "candidate",
  };
}

export function assessEvidenceResilience(input: {
  signalId: string;
  evidence: EvidenceItem[];
  componentActuallyUsed: boolean;
  affectedVersionMatches: boolean;
  codePathReachable: boolean | null;
  baselinePasses: boolean | null;
  candidateFails: boolean | null;
  packId: string;
  selectedCases: number;
  totalCases: number;
  completedRuns: number;
  requiredRuns: number;
}): EvidenceResilienceAssessment {
  const supporting = input.evidence.filter((item) => item.relationship === "supports");
  const contradictions = input.evidence.filter((item) => item.relationship === "contradicts");
  const authoritativeGroups = new Set(supporting.filter((item) => item.authoritative).map((item) => item.independenceGroup));
  const independentGroups = new Set(supporting.map((item) => item.independenceGroup));
  const blockingContradictions = contradictions.filter((item) => item.blocking);
  const reproduced = input.baselinePasses === true && input.candidateFails === true;
  const coverageComplete = input.selectedCases === input.totalCases && input.completedRuns >= input.requiredRuns;
  const suppressionReasons: string[] = [];
  if (authoritativeGroups.size === 0) suppressionReasons.push("NO_AUTHORITATIVE_SOURCE");
  if (contradictions.length > 0) suppressionReasons.push("CONTRADICTORY_EVIDENCE_REQUIRES_REVIEW");
  if (blockingContradictions.length > 0) suppressionReasons.push("UNRESOLVED_BLOCKING_CONTRADICTION");
  if (!input.componentActuallyUsed) suppressionReasons.push("COMPONENT_NOT_IN_WORKFLOW");
  if (!input.affectedVersionMatches) suppressionReasons.push("VERSION_NOT_APPLICABLE");
  if (input.codePathReachable !== true) suppressionReasons.push("CODE_PATH_NOT_REACHABLE");
  if (!reproduced) suppressionReasons.push("BASELINE_CANDIDATE_REPRODUCTION_MISSING");
  if (!coverageComplete) suppressionReasons.push("CANARY_COVERAGE_INCOMPLETE");
  return {
    schemaVersion: "1.0",
    signalId: input.signalId,
    corroboration: {
      independentSources: independentGroups.size,
      authoritativeSources: authoritativeGroups.size,
      contradictions: contradictions.length,
      unresolvedBlockingContradictions: blockingContradictions.length,
    },
    reproducibility: { reproduced, baselinePasses: input.baselinePasses, candidateFails: input.candidateFails },
    applicability: {
      componentActuallyUsed: input.componentActuallyUsed,
      affectedVersionMatches: input.affectedVersionMatches,
      codePathReachable: input.codePathReachable,
    },
    canaryCoverage: {
      packId: input.packId,
      selectedCases: input.selectedCases,
      totalCases: input.totalCases,
      completedRuns: input.completedRuns,
      requiredRuns: input.requiredRuns,
    },
    recommendationEligible: suppressionReasons.length === 0,
    suppressionReasons,
  };
}

export function createCanaryPack(dataset: Dataset, datasetFingerprint: string): CanaryPack {
  const invariants: Invariant[] = [
    {
      id: "caption-safe-area-9x16",
      name: "9:16 caption pixels stay inside the delivery safe area",
      component: "caption-compositor",
      description: "Decoded caption pixel bounds must remain fully inside the locked 1080×1920 safe area.",
      check: "behavior",
      severity: "blocking",
      gateMetric: "caption_safe_area_pass_rate",
    },
    {
      id: "output-validity-1080x1920",
      name: "Every output is a valid 1080×1920 delivery",
      component: "caption-compositor",
      description: "Every rendered MP4 must match dimensions and locked clip duration.",
      check: "schema",
      severity: "blocking",
      gateMetric: "output_validity_pass_rate",
    },
    {
      id: "paired-run-coverage",
      name: "All eight clips have paired baseline and candidate runs",
      component: "greenlight-canary-runner",
      description: "The full locked pack requires eight baseline and eight candidate completions.",
      check: "exact",
      severity: "blocking",
      gateMetric: "run_coverage",
    },
    {
      id: "render-p95-regression-budget",
      name: "Candidate p95 render time stays within the regression budget",
      component: "caption-compositor",
      description: "Candidate p95 render duration may not regress more than the committed soft threshold.",
      check: "performance",
      severity: "warning",
      gateMetric: "p95_render_duration",
    },
  ];
  const core = {
    schemaVersion: "1.0" as const,
    id: "vertical-social-caption-delivery",
    component: "caption-compositor",
    version: "1.0.0",
    dataset: { name: dataset.name, version: dataset.version, fingerprint: datasetFingerprint },
    cases: dataset.clips.map((clip) => ({ id: clip.id, name: clip.title, tags: [...clip.tags] })),
    invariants,
  };
  return { ...core, fingerprint: fingerprint(core) };
}

export function createCanaryRun(input: {
  pack: CanaryPack;
  gates: GateResult[];
  baselineVersion: string;
  candidateVersion: string;
  completedAt: string;
  evidenceIdsByMetric?: Record<string, string[]>;
}): CanaryRun {
  const checks = input.pack.invariants.map((invariant) => {
    const gate = input.gates.find((item) => item.metric === invariant.gateMetric);
    if (!gate) throw new Error(`Missing policy gate for invariant ${invariant.id}`);
    const baselinePass = invariant.gateMetric === "p95_render_duration"
      ? true
      : invariant.gateMetric === "run_coverage"
        ? gate.baseline + gate.candidate >= Number(gate.threshold.split("=")[1])
        : gate.baseline >= 1;
    return {
      invariantId: invariant.id,
      invariantName: invariant.name,
      severity: invariant.severity,
      baselinePass,
      candidatePass: gate.pass,
      measurement: { baseline: gate.baseline, candidate: gate.candidate, delta: gate.delta, threshold: gate.threshold, unit: gate.unit },
      evidenceIds: input.evidenceIdsByMetric?.[invariant.gateMetric] ?? [],
    };
  });
  const blockingFailures = checks.filter((check) => check.severity === "blocking" && !check.candidatePass).map((check) => check.invariantId);
  const core = {
    schemaVersion: "1.0" as const,
    id: `canary-run:${stableId(input.pack.id, input.pack.version, input.baselineVersion, input.candidateVersion, fingerprint(checks)).slice(0, 16)}`,
    packId: input.pack.id,
    packVersion: input.pack.version,
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    completedAt: input.completedAt,
    checks,
    blockingFailures,
  };
  return { ...core, fingerprint: fingerprint({ ...core, completedAt: undefined }) };
}

export function createEvidenceCasefile(input: {
  change: Change;
  signal: Signal;
  evidence: EvidenceItem[];
  resilience: EvidenceResilienceAssessment;
  affectedInventory: string[];
  replay: string;
}): EvidenceCasefile {
  const evidence = [...input.evidence].sort((left, right) => left.id.localeCompare(right.id));
  const contradictions = evidence.filter((item) => item.relationship === "contradicts");
  const signal = { ...input.signal, status: input.resilience.recommendationEligible ? "validated" as const : "needs_review" as const };
  const core = {
    schemaVersion: "1.0" as const,
    id: `casefile:${stableId(input.change.id, input.signal.id).slice(0, 16)}`,
    change: input.change,
    signal,
    evidence,
    contradictions,
    affectedInventory: [...input.affectedInventory].sort(),
    resilience: input.resilience,
    replay: input.replay,
  };
  return { ...core, fingerprint: fingerprint(core) };
}

export function createDecisionReceipt(input: {
  change: Change;
  evidenceCasefileFingerprint: string;
  signalFingerprint: string;
  canaryPackId: string;
  canaryPackVersion: string;
  canaryPackFingerprint: string;
  canaryRunFingerprint: string;
  policyName: string;
  policyVersion: string;
  policyHash: string;
  verdict: DecisionVerdict;
  reasons: string[];
  issuedAt: string;
  provenance: "local/synthetic" | "grafana-mcp";
}): DecisionReceipt {
  const commitments = {
    change: fingerprint(input.change),
    evidenceCasefile: input.evidenceCasefileFingerprint,
    signal: input.signalFingerprint,
    canaryPack: input.canaryPackFingerprint,
    canaryRun: input.canaryRunFingerprint,
    policy: input.policyHash,
  };
  const committed = {
    schemaVersion: "1.0" as const,
    provenance: input.provenance,
    commitments,
    canaryPack: { id: input.canaryPackId, version: input.canaryPackVersion },
    policy: { name: input.policyName, version: input.policyVersion, hash: input.policyHash, owner: "deterministic-policy-evaluator" as const },
    verdict: input.verdict,
    reasons: [...input.reasons],
  };
  const receiptFingerprint = fingerprint(committed);
  return Object.freeze({
    ...committed,
    id: `decision-receipt:${receiptFingerprint.slice(7, 23)}`,
    issuedAt: input.issuedAt,
    immutable: true as const,
    reasons: Object.freeze([...input.reasons]),
    fingerprint: receiptFingerprint,
  });
}

export function createDecisionOutcomeFixture(receipt: DecisionReceipt, recordedAt: string): DecisionOutcome {
  return {
    schemaVersion: "1.0",
    id: `decision-outcome-fixture:${receipt.fingerprint.slice(7, 23)}`,
    decisionReceiptFingerprint: receipt.fingerprint,
    provenance: "local/synthetic",
    synthetic: true,
    observationStatus: "fixture/not-observed",
    observedAt: null,
    recordedAt,
    result: "unknown",
    evidenceIds: [],
    statement: "Fixture only: no production deployment or production outcome was observed. This record demonstrates the outcome contract without claiming external truth.",
  };
}

function requireShape(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid decision artifact shape: ${message}`);
}

export function validateDecisionArtifactShapes(card: DecisionCard, casefile: EvidenceCasefile, receipt: DecisionReceipt, outcome: DecisionOutcome): void {
  requireShape(card.change?.id, "card.change.id");
  requireShape(card.evidenceCasefile?.fingerprint === casefile.fingerprint, "card casefile commitment");
  requireShape(Array.isArray(casefile.evidence) && casefile.evidence.length > 0, "casefile evidence");
  requireShape(typeof casefile.signal?.confidence === "number" && casefile.signal.confidenceVersion, "signal confidence basis");
  requireShape(card.canaryPack?.version && Array.isArray(card.canaryPack.invariants), "versioned canary pack");
  requireShape(card.canaryRun?.fingerprint, "canary run fingerprint");
  requireShape(card.decisionReceiptFingerprint === receipt.fingerprint, "receipt fingerprint");
  requireShape(receipt.immutable && receipt.policy.owner === "deterministic-policy-evaluator", "immutable policy-owned receipt");
  requireShape(outcome.observationStatus === "fixture/not-observed" && outcome.observedAt === null, "honest outcome fixture");
}
