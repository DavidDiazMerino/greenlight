export type Variant = "baseline" | "candidate";
export type RenderPath = "baseline-multipass" | "candidate-fused";
export type EvidenceKind = "metrics" | "logs" | "traces";
export type Provenance = "local/synthetic" | "grafana-mcp";
export type DecisionVerdict = "PROMOTE" | "HOLD" | "REJECT";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Clip {
  id: string;
  title: string;
  caption: string[];
  durationSeconds: number;
  accent: string;
  focusX: number;
  tags: string[];
}

export interface Dataset {
  name: string;
  version: string;
  description: string;
  canvas: { width: number; height: number };
  output: { width: number; height: number; fps: number };
  safeArea: Rect;
  clips: Clip[];
}

export interface CandidateManifest {
  candidate: string;
  baseline: string;
  component: string;
  affectedStages: string[];
  change: string;
  knownDemoDefect: string;
  dataset: string;
  policy: string;
}

export interface ExperimentSpec {
  candidate: string;
  baselineDigest: string;
  candidateDigest: string;
  affectedStages: string[];
  clipIds: string[];
  policyHash: string;
  requiredEvidence: EvidenceKind[];
  planner: "deterministic-local" | "gemini-adk";
}

export interface MediaQaResult {
  experimentId: string;
  clipId: string;
  variant: Variant;
  outputPath: string;
  noCaptionPath: string;
  captionBounds: Rect | null;
  safeArea: Rect;
  violationPx: number;
  safeAreaPass: boolean;
  outputValid: boolean;
  width: number;
  height: number;
  durationSeconds: number;
  expectedDurationSeconds: number;
  renderDurationMs: number;
  renderPath: RenderPath;
  compositorPasses: number;
  runCompleted: boolean;
  traceId: string;
}

export interface LocalLog {
  timestamp: string;
  experiment_id: string;
  clip_id: string;
  variant: Variant;
  stage: string;
  safe_area_bbox: [number, number, number, number] | null;
  violation_px: number;
  compositor_digest: string;
  render_path: RenderPath;
  compositor_passes: number;
  provenance: "local/synthetic";
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startUnixMs: number;
  endUnixMs: number;
  attributes: Record<string, string | number | boolean>;
}

export interface McpReceipt {
  receiptId: string;
  kind: EvidenceKind;
  serverIdentity: string;
  toolName: string;
  query: unknown;
  resultHash: string;
  receivedAt: string;
  traceIds?: string[];
}

export interface EvidenceBundle {
  schemaVersion: "1.0";
  experimentId: string;
  provenance: Provenance;
  synthetic: boolean;
  generatedAt: string;
  metrics: MediaQaResult[];
  logs: LocalLog[];
  traces: Span[];
  evidencePresent: EvidenceKind[];
  localReceipt: { bundleHash: string; source: "deterministic-local-runner" } | null;
  mcpReceipts: McpReceipt[];
}

export type EvidenceSourceType =
  | "candidate_manifest"
  | "dataset_manifest"
  | "render"
  | "media_qa"
  | "log"
  | "trace"
  | "policy"
  | "telemetry";

export interface EvidenceProvenance {
  scope: Provenance;
  producer: string;
  artifact: string;
  sourceFingerprint: string;
}

export interface Change {
  schemaVersion: "1.0";
  id: string;
  component: string;
  fromVersion: string;
  toVersion: string;
  detectedAt: string;
  provenance: Provenance;
  synthetic: boolean;
  sourceEvidenceIds: string[];
  affectedStages: string[];
  workflowImpact: string;
}

export interface EvidenceItem {
  schemaVersion: "1.0";
  id: string;
  sourceType: EvidenceSourceType;
  provenance: EvidenceProvenance;
  authoritative: boolean;
  independenceGroup: string;
  relationship: "supports" | "contradicts" | "context";
  claim: string;
  observedAt: string;
  contentFingerprint: string;
  synthetic: boolean;
  blocking: boolean;
}

export interface EvidenceSupportCheck {
  name: string;
  status: "verified" | "contradicted" | "missing";
  basis: string;
}

export interface Signal {
  schemaVersion: "1.0";
  id: string;
  changeId: string;
  affectedComponent: string;
  kind: "behavior_change" | "compatibility_risk" | "performance_regression";
  affectedAssets: string[];
  evidenceIds: string[];
  evidenceAssessmentVersion: string;
  supportChecks: EvidenceSupportCheck[];
  evidenceFingerprint: string;
  status: "candidate" | "validated" | "suppressed" | "needs_review";
}

export interface EvidenceResilienceAssessment {
  schemaVersion: "1.0";
  signalId: string;
  corroboration: {
    independentSources: number;
    authoritativeSources: number;
    contradictions: number;
    unresolvedBlockingContradictions: number;
  };
  reproducibility: {
    reproduced: boolean;
    baselinePasses: boolean | null;
    candidateFails: boolean | null;
  };
  applicability: {
    componentActuallyUsed: boolean;
    affectedVersionMatches: boolean;
    codePathReachable: boolean | null;
  };
  canaryCoverage: {
    packId: string;
    selectedCases: number;
    totalCases: number;
    completedRuns: number;
    requiredRuns: number;
  };
  recommendationEligible: boolean;
  suppressionReasons: string[];
}

export interface EvidenceCasefile {
  schemaVersion: "1.0";
  id: string;
  fingerprint: string;
  change: Change;
  signal: Signal;
  evidence: EvidenceItem[];
  contradictions: EvidenceItem[];
  affectedInventory: string[];
  resilience: EvidenceResilienceAssessment;
  replay: string;
}

export interface Invariant {
  id: string;
  name: string;
  component: string;
  description: string;
  check: "exact" | "range" | "schema" | "behavior" | "performance";
  severity: "info" | "warning" | "blocking";
  gateMetric: string;
}

export interface CanaryPack {
  schemaVersion: "1.0";
  id: string;
  component: string;
  version: string;
  dataset: { name: string; version: string; fingerprint: string };
  cases: Array<{ id: string; name: string; tags: string[] }>;
  invariants: Invariant[];
  fingerprint: string;
}

export interface CanaryCheckResult {
  invariantId: string;
  invariantName: string;
  severity: Invariant["severity"];
  baselinePass: boolean;
  candidatePass: boolean;
  measurement?: Pick<GateResult, "baseline" | "candidate" | "delta" | "threshold" | "unit">;
  evidenceIds: string[];
}

export interface CanaryRun {
  schemaVersion: "1.0";
  id: string;
  packId: string;
  packVersion: string;
  baselineVersion: string;
  candidateVersion: string;
  completedAt: string;
  checks: CanaryCheckResult[];
  blockingFailures: string[];
  fingerprint: string;
}

export interface Policy {
  name: string;
  version: string;
  requiredEvidence: EvidenceKind[];
  requiredRunCoverage: number;
  safeAreaRequired: number;
  outputValidityRequired: number;
  p95MaxRegression: number;
}

export interface GateResult {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  threshold: string;
  severity: "hard" | "soft";
  pass: boolean;
  unit: "rate" | "ms" | "runs";
}

export interface PolicyDecision {
  decision: DecisionVerdict;
  reason: "POLICY_PASSED" | "GATE_FAILED" | "INSUFFICIENT_EVIDENCE" | "INVALID_OUTPUT";
  deploymentBlocked: boolean;
  evidenceCompleteness: string;
  runCoverage: number;
  gates: GateResult[];
  blockingInvariantIds: string[];
}

export interface DecisionReceipt {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly issuedAt: string;
  readonly provenance: Provenance;
  readonly immutable: true;
  readonly commitments: {
    readonly change: string;
    readonly evidenceCasefile: string;
    readonly signal: string;
    readonly canaryPack: string;
    readonly canaryRun: string;
    readonly policy: string;
  };
  readonly canaryPack: { readonly id: string; readonly version: string };
  readonly policy: { readonly name: string; readonly version: string; readonly hash: string; readonly owner: "deterministic-policy-evaluator" };
  readonly verdict: DecisionVerdict;
  readonly reasons: readonly string[];
  readonly fingerprint: string;
}

export interface DecisionOutcome {
  schemaVersion: "1.0";
  id: string;
  decisionReceiptFingerprint: string;
  provenance: "local/synthetic";
  synthetic: true;
  observationStatus: "fixture/not-observed";
  observedAt: null;
  recordedAt: string;
  result: "unknown";
  evidenceIds: string[];
  statement: string;
}

export interface DecisionCard extends PolicyDecision {
  headline: string;
  baselineVersion: string;
  baselineDigest: string;
  candidateVersion: string;
  candidateDigest: string;
  experimentId: string;
  completedAt: string;
  policyName: string;
  policyVersion: string;
  policyHash: string;
  datasetName: string;
  datasetHash: string;
  affectedAssets: string[];
  diagnosis: string;
  recommendedAction: string;
  mcpReceipts: McpReceipt[];
  grafanaEvidenceRefs: string[];
  traceIds: string[];
  gitCommit: string;
  geminiModel: string;
  replayCommand: string;
  provenance: Provenance;
  synthetic: boolean;
  change: Change;
  evidenceCasefile: EvidenceCasefile;
  canaryPack: CanaryPack;
  canaryRun: CanaryRun;
  decisionReceiptFingerprint: string;
  policyOwner: "deterministic-policy-evaluator";
  renderComparison: {
    baseline: { path: RenderPath; compositorPasses: number; p95DurationMs: number };
    candidate: { path: RenderPath; compositorPasses: number; p95DurationMs: number };
    candidateP95Improvement: number;
  };
  hero: {
    clipId: string;
    baselineVideo: string;
    candidateVideo: string;
    baselinePoster: string;
    candidatePoster: string;
    baselineBounds: Rect | null;
    candidateBounds: Rect | null;
    safeArea: Rect;
  };
}
