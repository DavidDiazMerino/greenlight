import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DeterministicExperimentPlanner } from "../src/adapters/gemini.ts";
import { captionLayout, renderPipeline } from "../src/media.ts";
import { evaluatePolicy, loadPolicy } from "../src/policy.ts";
import type { CanaryRun, CandidateManifest, Dataset, EvidenceBundle, EvidenceResilienceAssessment, MediaQaResult, Variant } from "../src/types.ts";
import { projectRoot, readJson } from "../src/util.ts";
import { localEvidenceFingerprint, mcpReceiptId } from "../src/integrity.ts";
import { fingerprint } from "../src/util.ts";

const observedAt = "2026-08-24T00:00:00.000Z";

async function fixture() {
  const dataset = await readJson<Dataset>(join(projectRoot, "dataset", "vertical-social-v1.json"));
  const manifest = await readJson<CandidateManifest>(join(projectRoot, "dataset", "candidate-manifest.json"));
  const { policy, hash } = await loadPolicy(join(projectRoot, "policy", "vertical-delivery-v1.yaml"));
  return { dataset, manifest, policy, hash };
}

function metric(index: number, variant: Variant, safeAreaPass = true): MediaQaResult {
  return {
    experimentId: "test-experiment",
    clipId: `v${String(index + 1).padStart(2, "0")}`,
    variant,
    outputPath: "fixture.mp4",
    noCaptionPath: "fixture.png",
    captionBounds: { x: 120, y: safeAreaPass ? 1386 : 1483, width: 840, height: 208 },
    safeArea: { x: 90, y: 180, width: 900, height: 1450 },
    violationPx: safeAreaPass ? 0 : 61,
    safeAreaPass,
    outputValid: true,
    width: 1080,
    height: 1920,
    durationSeconds: 6,
    expectedDurationSeconds: 6,
    renderDurationMs: variant === "baseline" ? 1000 + index : 950 + index,
    renderPath: variant === "baseline" ? "baseline-multipass" : "candidate-fused",
    compositorPasses: variant === "baseline" ? 2 : 1,
    runCompleted: true,
    traceId: `${variant}-${index}`,
  };
}

function bundle(candidateFailures: number): EvidenceBundle {
  const metrics = [
    ...Array.from({ length: 8 }, (_, index) => metric(index, "baseline")),
    ...Array.from({ length: 8 }, (_, index) => metric(index, "candidate", index >= candidateFailures)),
  ];
  const evidence: EvidenceBundle = {
    schemaVersion: "1.0",
    experimentId: "test-experiment",
    provenance: "local/synthetic",
    synthetic: true,
    generatedAt: "2026-08-22T00:00:00.000Z",
    metrics,
    logs: metrics.map((item) => ({
      timestamp: "2026-08-22T00:00:00.000Z",
      experiment_id: item.experimentId,
      clip_id: item.clipId,
      variant: item.variant,
      stage: item.safeAreaPass ? "media_qa.safe_area" : "caption_layout",
      safe_area_bbox: item.captionBounds ? [item.captionBounds.x, item.captionBounds.y, item.captionBounds.width, item.captionBounds.height] : null,
      violation_px: item.violationPx,
      compositor_digest: "sha256:test",
      render_path: item.renderPath,
      compositor_passes: item.compositorPasses,
      provenance: "local/synthetic",
    })),
    traces: metrics.map((item, index) => ({
      traceId: item.traceId,
      spanId: `${index}`.padStart(16, "0"),
      name: "canary.run",
      startUnixMs: index,
      endUnixMs: index + 1,
      attributes: { variant: item.variant, clip_id: item.clipId, experiment_id: item.experimentId },
    })),
    toolchain: {
      font: { family: "DejaVu Sans", path: "assets/fonts/DejaVuSans.ttf", sha256: "sha256:font", fontConfigSha256: "sha256:fontconfig" },
      ffmpeg: { version: "ffmpeg test", binaryFingerprint: "sha256:ffmpeg" },
      ffprobe: { version: "ffprobe test", binaryFingerprint: "sha256:ffprobe" },
    },
    evidencePresent: ["metrics", "logs", "traces"],
    localReceipt: null,
    mcpReceipts: [],
  };
  evidence.localReceipt = { bundleHash: localEvidenceFingerprint(evidence), source: "deterministic-local-runner" };
  return evidence;
}

function eligibleResilience(): EvidenceResilienceAssessment {
  return {
    schemaVersion: "1.0",
    signalId: "signal:test",
    corroboration: { independentSources: 1, authoritativeSources: 3, contradictions: 0, unresolvedBlockingContradictions: 0 },
    reproducibility: { reproduced: true, baselinePasses: true, candidateFails: true },
    applicability: { componentActuallyUsed: true, affectedVersionMatches: true, codePathReachable: true },
    canaryCoverage: { packId: "vertical-social", selectedCases: 8, totalCases: 8, completedRuns: 16, requiredRuns: 16 },
    recommendationEligible: true,
    suppressionReasons: [],
  };
}

test("candidate is held when the hard caption safe-area gate fails", async () => {
  const { policy } = await fixture();
  const result = evaluatePolicy(bundle(5), policy);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reason, "GATE_FAILED");
  assert.equal(result.gates.find((gate) => gate.metric === "caption_safe_area_pass_rate")?.candidate, 0.375);
});

test("an all-pass comparison is promotable with complete local evidence", async () => {
  const { policy } = await fixture();
  const result = evaluatePolicy(bundle(0), policy, { requireMcp: false, resilience: eligibleResilience() });
  assert.equal(result.decision, "PROMOTE");
  assert.equal(result.deploymentBlocked, false);
});

test("complete canary evidence without recommendation eligibility remains on hold", async () => {
  const { policy } = await fixture();
  const result = evaluatePolicy(bundle(0), policy);
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.deploymentBlocked, true);
});

test("contradictory or inapplicable evidence cannot promote an otherwise passing candidate", async () => {
  const { policy } = await fixture();
  const resilience = eligibleResilience();
  resilience.recommendationEligible = false;
  resilience.applicability.codePathReachable = false;
  resilience.corroboration.contradictions = 1;
  resilience.suppressionReasons = ["CONTRADICTORY_EVIDENCE_BLOCKS_PROMOTION", "CODE_PATH_NOT_REACHABLE"];
  const result = evaluatePolicy(bundle(0), policy, { requireMcp: false, resilience, suggestedAction: "PROMOTE" });
  assert.equal(result.decision, "HOLD");
  assert.equal(result.deploymentBlocked, true);
});

test("a blocking invariant holds the candidate regardless of an AI-style promote suggestion", async () => {
  const { policy } = await fixture();
  const canaryRun: CanaryRun = {
    schemaVersion: "1.0",
    id: "canary-run:test",
    packId: "vertical-social",
    packVersion: "1.0.0",
    baselineVersion: "caption-compositor@0.1.0",
    candidateVersion: "caption-compositor@0.2.0-rc1",
    completedAt: "2026-08-22T00:00:00.000Z",
    checks: [{ invariantId: "caption-safe-area-9x16", invariantName: "9:16 caption pixels stay inside the delivery safe area", severity: "blocking", baselinePass: true, candidatePass: false, evidenceIds: ["evidence:qa"] }],
    blockingFailures: ["caption-safe-area-9x16"],
    fingerprint: "sha256:canary",
  };
  const result = evaluatePolicy(bundle(0), policy, {
    requireMcp: false,
    resilience: eligibleResilience(),
    canaryRun,
    suggestedAction: "PROMOTE",
  });
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reason, "GATE_FAILED");
  assert.deepEqual(result.blockingInvariantIds, ["caption-safe-area-9x16"]);
});

test("an MCP-required path rejects local evidence without MCP receipts", async () => {
  const { policy } = await fixture();
  const result = evaluatePolicy(bundle(0), policy, { requireMcp: true });
  assert.equal(result.decision, "HOLD");
  assert.equal(result.reason, "INSUFFICIENT_EVIDENCE");
  assert.match(result.evidenceCompleteness, /Grafana MCP/);
});

test("MCP-required evidence accepts a baseline/candidate trace pair across receipted Tempo calls", async () => {
  const { policy } = await fixture();
  const evidence = bundle(0);
  evidence.provenance = "grafana-mcp";
  evidence.synthetic = true;
  evidence.localReceipt = null;
  const proofInputs = [
    { kind: "metrics" as const, toolName: "query_prometheus", result: { data: [{ value: 1 }] }, traceIds: undefined },
    { kind: "logs" as const, toolName: "query_loki_logs", result: { data: [{ line: "ok" }] }, traceIds: undefined },
    { kind: "traces" as const, toolName: "tempo_get_trace", result: { traces: [{ traceId: "0123456789abcdef0123456789abcdef" }] }, traceIds: ["0123456789abcdef0123456789abcdef"] },
    { kind: "traces" as const, toolName: "tempo_get_trace", result: { traces: [{ traceId: "fedcba9876543210fedcba9876543210" }] }, traceIds: ["fedcba9876543210fedcba9876543210"] },
  ];
  evidence.mcpReceipts = proofInputs.map(({ kind, toolName, result, traceIds }) => {
    const base = { kind, serverIdentity: "grafana-test", toolName, query: {}, resultHash: fingerprint(result), receivedAt: observedAt, dataPresent: true, traceIds };
    return { ...base, receiptId: mcpReceiptId(base) };
  });
  evidence.mcpProofs = evidence.mcpReceipts.map((receipt, index) => ({ receiptId: receipt.receiptId, result: proofInputs[index].result }));
  const result = evaluatePolicy(evidence, policy, { requireMcp: true, resilience: eligibleResilience() });
  assert.equal(result.decision, "PROMOTE");
});

test("forged local and MCP receipt hashes fail closed", async () => {
  const { policy } = await fixture();
  const local = bundle(0);
  local.localReceipt!.bundleHash = `sha256:${"0".repeat(64)}`;
  assert.equal(evaluatePolicy(local, policy, { requireMcp: false, resilience: eligibleResilience() }).reason, "INSUFFICIENT_EVIDENCE");

  const remote = bundle(0);
  remote.provenance = "grafana-mcp";
  remote.localReceipt = null;
  remote.mcpReceipts = [{
    receiptId: "forged",
    kind: "metrics",
    serverIdentity: "grafana-test",
    toolName: "query_prometheus",
    query: {},
    resultHash: `sha256:${"0".repeat(64)}`,
    dataPresent: true,
  }];
  remote.mcpProofs = [{ receiptId: "forged", result: { data: [{ value: 1 }] } }];
  assert.equal(evaluatePolicy(remote, policy, { requireMcp: true, resilience: eligibleResilience() }).reason, "INSUFFICIENT_EVIDENCE");
});

test("policy parsing follows named YAML gates rather than document order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "greenlight-policy-"));
  const path = join(directory, "reordered.yaml");
  try {
    await writeFile(path, [
      "name: vertical-delivery",
      "version: v1",
      "required_evidence: [metrics, logs, traces]",
      "required_run_coverage: 16",
      "gates:",
      "  output_validity_pass_rate:",
      "    required: 0.75",
      "  p95_render_duration:",
      "    max_regression: 0.2",
      "  caption_safe_area_pass_rate:",
      "    required: 1.0",
    ].join("\n"), "utf8");
    const { policy } = await loadPolicy(path, null);
    assert.equal(policy.safeAreaRequired, 1);
    assert.equal(policy.outputValidityRequired, 0.75);
    assert.equal(policy.p95MaxRegression, 0.2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rc1 coordinate transform places multiline blocks outside the safe area", async () => {
  const { dataset } = await fixture();
  const clip = dataset.clips.find((item) => item.id === "v04")!;
  const baseline = captionLayout(clip, dataset, "baseline").bounds;
  const candidate = captionLayout(clip, dataset, "candidate").bounds;
  const safeBottom = dataset.safeArea.y + dataset.safeArea.height;
  assert.ok(baseline.y + baseline.height <= safeBottom);
  assert.ok(candidate.y + candidate.height > safeBottom);
});

test("candidate uses one real compositor pass while baseline materializes two", () => {
  assert.deepEqual(renderPipeline("baseline"), {
    path: "baseline-multipass",
    compositorPasses: 2,
    stages: ["portrait-caption-raster", "delivery-raster-normalization"],
  });
  assert.deepEqual(renderPipeline("candidate"), {
    path: "candidate-fused",
    compositorPasses: 1,
    stages: ["fused-portrait-caption-delivery-raster"],
  });
});

test("deterministic Experiment Agent selects all eight affected clips", async () => {
  const { dataset, manifest, hash } = await fixture();
  const plan = await new DeterministicExperimentPlanner().plan({
    manifest,
    dataset,
    baselineDigest: "sha256:baseline",
    candidateDigest: "sha256:candidate",
    policyHash: hash,
    requiredEvidence: ["metrics", "logs", "traces"],
  });
  assert.deepEqual(plan.clipIds, dataset.clips.map((clip) => clip.id));
  assert.equal(plan.planner, "deterministic-local");
});
