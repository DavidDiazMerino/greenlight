import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessEvidenceResilience,
  createDecisionOutcomeFixture,
  createDecisionReceipt,
  createSignal,
  fingerprintEvidenceItems,
  validateDecisionArtifactShapes,
} from "../src/evidence.ts";
import type { Change, DecisionCard, EvidenceItem } from "../src/types.ts";

const observedAt = "2026-08-22T00:00:00.000Z";

function item(id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    schemaVersion: "1.0",
    id,
    sourceType: "media_qa",
    provenance: {
      scope: "local/synthetic",
      producer: "greenlight-test",
      artifact: `fixture://${id}`,
      sourceFingerprint: `sha256:${id}`,
    },
    authoritative: true,
    independenceGroup: "local-runner",
    relationship: "supports",
    claim: "candidate caption pixels exceed the safe area",
    observedAt,
    contentFingerprint: `sha256:content-${id}`,
    synthetic: true,
    blocking: false,
    ...overrides,
  };
}

function change(): Change {
  return {
    schemaVersion: "1.0",
    id: "change:caption-compositor-0.2.0-rc1",
    component: "caption-compositor",
    fromVersion: "caption-compositor@0.1.0",
    toVersion: "caption-compositor@0.2.0-rc1",
    detectedAt: observedAt,
    provenance: "local/synthetic",
    synthetic: true,
    sourceEvidenceIds: ["evidence:manifest"],
    affectedStages: ["portrait_reframe", "caption_layout", "render"],
    workflowImpact: "Maya's 9:16 caption finishing path is exercised by this compositor change.",
  };
}

test("evidence fingerprints are order-independent and provenance-sensitive", () => {
  const first = item("evidence:a");
  const second = item("evidence:b");
  assert.equal(fingerprintEvidenceItems([first, second]), fingerprintEvidenceItems([second, first]));
  assert.notEqual(
    fingerprintEvidenceItems([first, second]),
    fingerprintEvidenceItems([first, { ...second, provenance: { ...second.provenance, artifact: "fixture://different" } }]),
  );
});

test("a strong applicable reproduced signal is recommendation eligible", () => {
  const evidence = [item("evidence:manifest", { independenceGroup: "manifest" }), item("evidence:qa")];
  const signal = createSignal({
    change: change(),
    kind: "behavior_change",
    affectedAssets: ["v02", "v03", "v04", "v05", "v07"],
    evidence,
    supportChecks: [
      { name: "direct_applicability", status: "verified", basis: "component, version, and code path match" },
      { name: "reproduction", status: "verified", basis: "baseline passes and candidate fails" },
    ],
    evidenceAssessmentVersion: "evidence-assessment/v1",
  });
  const resilience = assessEvidenceResilience({
    signalId: signal.id,
    evidence,
    componentActuallyUsed: true,
    affectedVersionMatches: true,
    codePathReachable: true,
    baselinePasses: true,
    candidateFails: true,
    packId: "vertical-social",
    selectedCases: 8,
    totalCases: 8,
    completedRuns: 16,
    requiredRuns: 16,
  });
  assert.equal(resilience.recommendationEligible, true);
  assert.deepEqual(resilience.suppressionReasons, []);
  assert.equal(signal.status, "validated");
  assert.equal(signal.evidenceIds.length, 2);
});

test("a blocking contradiction or inapplicable code path suppresses recommendation eligibility", () => {
  const evidence = [
    item("evidence:manifest", { independenceGroup: "manifest" }),
    item("evidence:contradiction", { relationship: "contradicts", blocking: true, authoritative: true, independenceGroup: "control" }),
  ];
  const resilience = assessEvidenceResilience({
    signalId: "signal:test",
    evidence,
    componentActuallyUsed: true,
    affectedVersionMatches: true,
    codePathReachable: false,
    baselinePasses: true,
    candidateFails: true,
    packId: "vertical-social",
    selectedCases: 8,
    totalCases: 8,
    completedRuns: 16,
    requiredRuns: 16,
  });
  assert.equal(resilience.recommendationEligible, false);
  assert.ok(resilience.suppressionReasons.includes("UNRESOLVED_BLOCKING_CONTRADICTION"));
  assert.ok(resilience.suppressionReasons.includes("CODE_PATH_NOT_REACHABLE"));
});

test("decision receipt fingerprint is stable and changes with committed verdict inputs", () => {
  const input = {
    change: change(),
    evidenceCasefileFingerprint: "sha256:casefile",
    signalFingerprint: "sha256:signal",
    canaryPackId: "vertical-social",
    canaryPackVersion: "1.0.0",
    canaryPackFingerprint: "sha256:pack",
    canaryRunFingerprint: "sha256:run",
    policyName: "vertical-delivery",
    policyVersion: "v1",
    policyHash: "sha256:policy",
    verdict: "HOLD" as const,
    reasons: ["GATE_FAILED", "caption-safe-area-9x16"],
    issuedAt: observedAt,
    provenance: "local/synthetic" as const,
  };
  const first = createDecisionReceipt(input);
  const second = createDecisionReceipt({ ...input, reasons: [...input.reasons] });
  const changed = createDecisionReceipt({ ...input, verdict: "REJECT" as const });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.equal(first.commitments.policy, "sha256:policy");
});

test("decision artifacts expose auditable casefile, receipt, outcome, and accessible card fields", () => {
  const receipt = createDecisionReceipt({
    change: change(), evidenceCasefileFingerprint: "sha256:casefile", signalFingerprint: "sha256:signal",
    canaryPackId: "vertical-social", canaryPackVersion: "1.0.0", canaryPackFingerprint: "sha256:pack", canaryRunFingerprint: "sha256:run",
    policyName: "vertical-delivery", policyVersion: "v1", policyHash: "sha256:policy", verdict: "HOLD", reasons: ["GATE_FAILED"],
    issuedAt: observedAt, provenance: "local/synthetic",
  });
  const outcome = createDecisionOutcomeFixture(receipt, observedAt);
  const card = {
    change: change(),
    evidenceCasefile: { schemaVersion: "1.0", id: "casefile:test", fingerprint: "sha256:casefile", signal: { evidenceAssessmentVersion: "evidence-assessment/v1", supportChecks: [{ name: "fixture", status: "verified", basis: "test fixture" }] }, evidence: [item("evidence:a")], contradictions: [], resilience: { recommendationEligible: true }, affectedInventory: ["caption-compositor"], replay: "npm run canary" },
    canaryPack: { schemaVersion: "1.0", id: "vertical-social", version: "1.0.0", fingerprint: "sha256:pack", invariants: [] },
    canaryRun: { schemaVersion: "1.0", id: "run:test", fingerprint: "sha256:run", blockingFailures: [] },
    renderComparison: { baseline: { path: "baseline-multipass", compositorPasses: 2, p95DurationMs: 1000 }, candidate: { path: "candidate-fused", compositorPasses: 1, p95DurationMs: 900 }, candidateP95Improvement: 0.1 },
    decisionReceiptFingerprint: receipt.fingerprint,
    policyOwner: "deterministic-policy-evaluator",
  } as unknown as DecisionCard;
  assert.doesNotThrow(() => validateDecisionArtifactShapes(card, card.evidenceCasefile, receipt, outcome));
  assert.equal(outcome.provenance, "local/synthetic");
  assert.equal(outcome.observationStatus, "fixture/not-observed");
  assert.equal(outcome.observedAt, null);
});
