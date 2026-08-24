import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeterministicExperimentPlanner } from "./adapters/gemini.ts";
import {
  assessEvidenceResilience,
  createCanaryPack,
  createCanaryRun,
  createDecisionOutcomeFixture,
  createDecisionReceipt,
  createEvidenceCasefile,
  createEvidenceItem,
  createSignal,
  validateDecisionArtifactShapes,
} from "./evidence.ts";
import { assertFfmpegAvailable, generateOriginal, renderNoCaption, renderVariant, runMediaQa } from "./media.ts";
import { evaluatePolicy, loadPolicy } from "./policy.ts";
import { buildLog, buildTrace, prometheusText } from "./telemetry.ts";
import type { CandidateManifest, Change, Dataset, DecisionCard, DecisionOutcome, DecisionReceipt, EvidenceBundle, EvidenceCasefile, EvidenceItem, MediaQaResult } from "./types.ts";
import { fingerprint, hashFile, percentile95, projectRoot, rel, round, sha256, stableId, readJson, writeJson } from "./util.ts";

export interface CanaryResult {
  experimentId: string;
  artifactDir: string;
  decisionCard: DecisionCard;
  evidenceBundle: EvidenceBundle;
  evidenceCasefile: EvidenceCasefile;
  decisionReceipt: DecisionReceipt;
  decisionOutcome: DecisionOutcome;
}

function compositorDigest(version: string, algorithm: string, implementationHash: string): string {
  return sha256(JSON.stringify({ component: "caption-compositor", version, algorithm, implementationHash }));
}

async function artifactIndex(root: string, current = root): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const output: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...await artifactIndex(root, path));
    else if (entry.name !== "artifact-index.json") output.push({ path: path.slice(root.length + 1), bytes: (await stat(path)).size, sha256: await hashFile(path) });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function gitCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) return "uncommitted-local-worktree";
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: projectRoot, encoding: "utf8" });
  return `${result.stdout.trim()}${status.status === 0 && status.stdout.trim() ? "-dirty" : ""}`;
}

export async function runCanary(): Promise<CanaryResult> {
  assertFfmpegAvailable();
  const datasetPath = join(projectRoot, "dataset", "vertical-social-v1.json");
  const manifestPath = join(projectRoot, "dataset", "candidate-manifest.json");
  const policyPath = join(projectRoot, "policy", "vertical-delivery-v1.yaml");
  const [dataset, manifest, datasetHash, manifestHash, loadedPolicy] = await Promise.all([
    readJson<Dataset>(datasetPath),
    readJson<CandidateManifest>(manifestPath),
    hashFile(datasetPath),
    hashFile(manifestPath),
    loadPolicy(policyPath),
  ]);
  if (dataset.clips.length !== 8) throw new Error(`vertical-social-v1 must contain exactly 8 clips; found ${dataset.clips.length}`);

  const implementationHash = await hashFile(join(projectRoot, "src", "media.ts"));
  const baselineDigest = compositorDigest(manifest.baseline, "two-pass-final-portrait-safe-area-anchor", implementationHash);
  const candidateDigest = compositorDigest(manifest.candidate, "fused-pre-transform-anchor-mapped-after-layout", implementationHash);
  const experimentId = `gl-local-${stableId(datasetHash, manifestHash, loadedPolicy.hash, baselineDigest, candidateDigest).slice(0, 12)}`;
  const artifactDir = join(projectRoot, "artifacts", experimentId);
  const mediaDir = join(artifactDir, "media");
  const originalsDir = join(projectRoot, "assets", "synthetic", "generated");
  await mkdir(mediaDir, { recursive: true });

  const planner = new DeterministicExperimentPlanner();
  const experimentSpec = await planner.plan({
    manifest,
    dataset,
    baselineDigest,
    candidateDigest,
    policyHash: loadedPolicy.hash,
    requiredEvidence: loadedPolicy.policy.requiredEvidence,
  });
  await writeJson(join(artifactDir, "experiment-spec.json"), experimentSpec);

  const metrics: MediaQaResult[] = [];
  const originalInventory: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();
  for (const [clipIndex, clip] of dataset.clips.entries()) {
    if (!experimentSpec.clipIds.includes(clip.id)) continue;
    const original = await generateOriginal(clip, dataset, originalsDir);
    originalInventory.push({
      clipId: clip.id,
      poster: rel(original.poster),
      posterHash: await hashFile(original.poster),
      video: rel(original.video),
      videoHash: await hashFile(original.video),
      cues: clip.caption,
      durationSeconds: clip.durationSeconds,
      rights: "original synthetic; MIT",
    });
    const noCaptionPath = await renderNoCaption(clip, dataset, mediaDir);
    for (const variant of ["baseline", "candidate"] as const) {
      const rendered = await renderVariant(clip, dataset, variant, mediaDir);
      const qa = runMediaQa({
        experimentId,
        clip,
        dataset,
        variant,
        noCaptionPath,
        posterPath: rendered.poster,
        videoPath: rendered.video,
        renderDurationMs: rendered.renderDurationMs,
        renderPath: rendered.renderPath,
        compositorPasses: rendered.compositorPasses,
      });
      metrics.push(qa);
      await writeJson(join(mediaDir, clip.id, `${variant}-qa.json`), {
        ...qa,
        declaredLayout: rendered.declaredLayout,
        renderPipeline: { path: rendered.renderPath, compositorPasses: rendered.compositorPasses },
        qaMethod: "decoded RGB pixel diff against no-caption portrait render",
      });
      process.stdout.write(`[${clipIndex + 1}/8] ${clip.id} ${variant}: safe=${qa.safeAreaPass} violation=${qa.violationPx}px valid=${qa.outputValid} render=${qa.renderDurationMs}ms\n`);
    }
  }

  const generatedAt = new Date().toISOString();
  const logs = metrics.map((metric) => buildLog(metric, metric.variant === "baseline" ? baselineDigest : candidateDigest, generatedAt));
  const traces = metrics.flatMap((metric, index) => buildTrace(metric, metric.variant === "baseline" ? baselineDigest : candidateDigest, startedAt + index * 10_000));
  const receiptPayload = JSON.stringify({ experimentId, metrics, logs, traces });
  const evidenceBundle: EvidenceBundle = {
    schemaVersion: "1.0",
    experimentId,
    provenance: "local/synthetic",
    synthetic: true,
    generatedAt,
    metrics,
    logs,
    traces,
    evidencePresent: ["metrics", "logs", "traces"],
    localReceipt: { bundleHash: sha256(receiptPayload), source: "deterministic-local-runner" },
    mcpReceipts: [],
  };
  const failures = metrics.filter((metric) => metric.variant === "candidate" && !metric.safeAreaPass);
  if (failures.length !== 5) throw new Error(`Expected five measured rc1 safe-area regressions; found ${failures.length}`);
  const heroCandidate = [...failures].sort((a, b) => b.violationPx - a.violationPx)[0] ?? metrics.find((m) => m.variant === "candidate")!;
  const heroBaseline = metrics.find((metric) => metric.variant === "baseline" && metric.clipId === heroCandidate.clipId)!;
  const candidateP95 = percentile95(metrics.filter((m) => m.variant === "candidate").map((m) => m.renderDurationMs));
  const baselineP95 = percentile95(metrics.filter((m) => m.variant === "baseline").map((m) => m.renderDurationMs));
  const maxViolation = Math.max(...failures.map((item) => item.violationPx), 0);
  const canaryPack = createCanaryPack(dataset, datasetHash);

  const manifestChangeEvidence = createEvidenceItem({
    idHint: `${experimentId}:manifest-change`,
    sourceType: "candidate_manifest",
    provenance: { scope: "local/synthetic", producer: "repository-owned candidate manifest", artifact: "dataset/candidate-manifest.json", sourceFingerprint: manifestHash },
    authoritative: true,
    independenceGroup: "candidate-manifest",
    relationship: "supports",
    claim: `${manifest.candidate} changes ${manifest.affectedStages.join(", ")} by fusing portrait reframe, caption layout, and burn-in.`,
    observedAt: generatedAt,
    synthetic: true,
    blocking: false,
  });
  const manifestDefectEvidence = createEvidenceItem({
    idHint: `${experimentId}:manifest-defect`,
    sourceType: "candidate_manifest",
    provenance: { scope: "local/synthetic", producer: "repository-owned candidate manifest", artifact: "dataset/candidate-manifest.json", sourceFingerprint: manifestHash },
    authoritative: true,
    independenceGroup: "candidate-manifest",
    relationship: "supports",
    claim: `The fixture manifest discloses the rc1 multiline pre-transform coordinate defect; it is not an upstream or third-party claim.`,
    observedAt: generatedAt,
    synthetic: true,
    blocking: false,
  });
  const change: Change = {
    schemaVersion: "1.0",
    id: `change:${stableId(manifest.component, manifest.baseline, manifest.candidate, manifestHash).slice(0, 16)}`,
    component: manifest.component,
    fromVersion: manifest.baseline,
    toVersion: manifest.candidate,
    detectedAt: generatedAt,
    provenance: "local/synthetic",
    synthetic: true,
    sourceEvidenceIds: [manifestChangeEvidence.id, manifestDefectEvidence.id],
    affectedStages: [...manifest.affectedStages],
    workflowImpact: "Maya's portrait finishing path uses this compositor for reframe, caption layout, and burn-in; the changed multiline code path directly determines whether 9:16 deliverables remain publishable.",
  };
  const datasetEvidence = createEvidenceItem({
    idHint: `${experimentId}:dataset`, sourceType: "dataset_manifest",
    provenance: { scope: "local/synthetic", producer: "vertical-social-v1 fixture", artifact: "dataset/vertical-social-v1.json", sourceFingerprint: datasetHash },
    authoritative: true, independenceGroup: "locked-dataset", relationship: "supports",
    claim: `The versioned pack contains eight locked synthetic clips and a single shared EditPlan path for paired baseline/candidate comparison.`,
    observedAt: generatedAt, synthetic: true, blocking: false,
  });
  const qaEvidence = failures.map((result) => createEvidenceItem({
    idHint: `${experimentId}:qa:${result.clipId}`, sourceType: "media_qa",
    provenance: { scope: "local/synthetic", producer: "decoded RGB pixel-diff QA", artifact: `artifacts/${experimentId}/media/${result.clipId}/`, sourceFingerprint: fingerprint({ baseline: metrics.find((item) => item.variant === "baseline" && item.clipId === result.clipId), candidate: result }) },
    authoritative: true, independenceGroup: "deterministic-media-qa", relationship: "supports",
    claim: `${result.clipId} baseline passes while rc1 candidate fails the 9:16 caption safe area by ${result.violationPx}px.`,
    observedAt: generatedAt, synthetic: true, blocking: true,
  }));
  const renderEvidence = createEvidenceItem({
    idHint: `${experimentId}:renders`, sourceType: "render",
    provenance: { scope: "local/synthetic", producer: "local FFmpeg renderer and FFprobe", artifact: `artifacts/${experimentId}/metrics.json`, sourceFingerprint: fingerprint(metrics.map(({ clipId, variant, outputPath, width, height, durationSeconds, outputValid }) => ({ clipId, variant, outputPath, width, height, durationSeconds, outputValid }))) },
    authoritative: true, independenceGroup: "local-render-run", relationship: "supports",
    claim: `Sixteen paired outputs were rendered and probed; baseline passes and the candidate fails the caption invariant on ${failures.length} named clips.`,
    observedAt: generatedAt, synthetic: true, blocking: false,
  });
  const logEvidence = createEvidenceItem({
    idHint: `${experimentId}:logs`, sourceType: "log",
    provenance: { scope: "local/synthetic", producer: "local structured logger", artifact: `artifacts/${experimentId}/logs.jsonl`, sourceFingerprint: fingerprint(logs) },
    authoritative: true, independenceGroup: "local-run-telemetry", relationship: "supports",
    claim: `Structured local logs identify caption_layout and measured violation pixels for every failed candidate clip.`,
    observedAt: generatedAt, synthetic: true, blocking: false,
  });
  const traceEvidence = createEvidenceItem({
    idHint: `${experimentId}:traces`, sourceType: "trace",
    provenance: { scope: "local/synthetic", producer: "local trace-shaped telemetry builder", artifact: `artifacts/${experimentId}/traces.json`, sourceFingerprint: fingerprint(traces) },
    authoritative: true, independenceGroup: "local-run-telemetry", relationship: "supports",
    claim: `Local trace-shaped records preserve paired baseline/candidate stage context; they are not Tempo or Grafana MCP traces.`,
    observedAt: generatedAt, synthetic: true, blocking: false,
  });
  const policyEvidence = createEvidenceItem({
    idHint: `${experimentId}:policy`, sourceType: "policy",
    provenance: { scope: "local/synthetic", producer: "committed deterministic policy", artifact: "policy/vertical-delivery-v1.yaml", sourceFingerprint: loadedPolicy.hash },
    authoritative: true, independenceGroup: "release-policy", relationship: "context",
    claim: `vertical-delivery@${loadedPolicy.policy.version} requires 100% caption safe-area and output-validity pass rates across 16 runs.`,
    observedAt: generatedAt, synthetic: true, blocking: false,
  });
  const candidateFaster = candidateP95 < baselineP95;
  const performanceEvidence = createEvidenceItem({
    idHint: `${experimentId}:timing-comparison`, sourceType: "telemetry",
    provenance: { scope: "local/synthetic", producer: "local wall-clock timing", artifact: `artifacts/${experimentId}/metrics.json`, sourceFingerprint: fingerprint({ baselineP95, candidateP95 }) },
    authoritative: false, independenceGroup: "local-run-timing", relationship: candidateFaster ? "supports" : "contradicts",
    claim: candidateFaster
      ? `This local run measures ${round(baselineP95, 1)}ms baseline p95 across the two-pass compositor and ${round(candidateP95, 1)}ms candidate p95 across the fused compositor. Wall-clock timing is environment-dependent; the exact paths and measurements remain attached.`
      : `This local run measures ${round(baselineP95, 1)}ms baseline p95 and ${round(candidateP95, 1)}ms candidate p95, so it does not reproduce the intended fused-path speed benefit. This does not contradict the decoded-pixel regression.`,
    observedAt: generatedAt, synthetic: true, blocking: false,
  });
  const evidenceItems: EvidenceItem[] = [manifestChangeEvidence, manifestDefectEvidence, datasetEvidence, ...qaEvidence, renderEvidence, logEvidence, traceEvidence, policyEvidence, performanceEvidence];
  const signal = createSignal({
    change,
    kind: "behavior_change",
    affectedAssets: failures.map((item) => item.clipId),
    evidence: [manifestDefectEvidence, ...qaEvidence],
    evidenceAssessmentVersion: "evidence-assessment/v1",
    supportChecks: [
      { name: "source_authority", status: "verified", basis: "repository-owned manifest discloses the local candidate and defect" },
      { name: "provenance_integrity", status: "verified", basis: "all evidence is content-fingerprinted and explicitly local/synthetic" },
      { name: "direct_applicability", status: "verified", basis: "component, rc1 version, and multiline caption path match Maya's workflow" },
      { name: "baseline_candidate_reproduction", status: "verified", basis: "locked baseline passes and the same five candidate clips fail decoded-pixel QA" },
      { name: "canary_coverage", status: "verified", basis: "8/8 cases and 16/16 paired runs completed" },
      {
        name: "performance_claim",
        status: candidateFaster ? "verified" : "contradicted",
        basis: `${round(baselineP95, 1)}ms baseline p95 (two passes) versus ${round(candidateP95, 1)}ms candidate p95 (one fused pass) in this local run`,
      },
    ],
  });
  const baselinePasses = metrics.filter((item) => item.variant === "baseline").every((item) => item.safeAreaPass && item.outputValid);
  const resilience = assessEvidenceResilience({
    signalId: signal.id, evidence: evidenceItems,
    componentActuallyUsed: manifest.component === "caption-compositor",
    affectedVersionMatches: manifest.candidate === "caption-compositor@0.2.0-rc1",
    codePathReachable: failures.every((item) => dataset.clips.find((clip) => clip.id === item.clipId)?.tags.includes("multiline") === true),
    baselinePasses, candidateFails: failures.length > 0,
    packId: canaryPack.id, selectedCases: experimentSpec.clipIds.length, totalCases: canaryPack.cases.length,
    completedRuns: metrics.filter((item) => item.runCompleted).length, requiredRuns: loadedPolicy.policy.requiredRunCoverage,
  });
  const evidenceCasefile = createEvidenceCasefile({
    change, signal, evidence: evidenceItems, resilience,
    affectedInventory: [manifest.component, ...manifest.affectedStages], replay: "npm run canary",
  });
  const provisionalDecision = evaluatePolicy(evidenceBundle, loadedPolicy.policy, { requireMcp: false, resilience });
  const evidenceIdsByMetric = {
    caption_safe_area_pass_rate: qaEvidence.map((item) => item.id),
    output_validity_pass_rate: [renderEvidence.id],
    p95_render_duration: [performanceEvidence.id],
    run_coverage: [datasetEvidence.id, renderEvidence.id],
  };
  const canaryRun = createCanaryRun({
    pack: canaryPack, gates: provisionalDecision.gates, baselineVersion: manifest.baseline, candidateVersion: manifest.candidate,
    completedAt: generatedAt, evidenceIdsByMetric,
  });
  const localDecision = evaluatePolicy(evidenceBundle, loadedPolicy.policy, { requireMcp: false, resilience, canaryRun });
  const mcpRequiredDecision = evaluatePolicy(evidenceBundle, loadedPolicy.policy, { requireMcp: true, resilience, canaryRun });
  const receiptReasons = [...new Set([localDecision.reason, ...canaryRun.blockingFailures, ...resilience.suppressionReasons])];
  const decisionReceipt = createDecisionReceipt({
    change, evidenceCasefileFingerprint: evidenceCasefile.fingerprint, signalFingerprint: fingerprint(evidenceCasefile.signal),
    canaryPackId: canaryPack.id, canaryPackVersion: canaryPack.version, canaryPackFingerprint: canaryPack.fingerprint,
    canaryRunFingerprint: canaryRun.fingerprint, policyName: loadedPolicy.policy.name, policyVersion: loadedPolicy.policy.version,
    policyHash: loadedPolicy.hash, verdict: localDecision.decision, reasons: receiptReasons, issuedAt: generatedAt, provenance: "local/synthetic",
  });
  const decisionOutcome = createDecisionOutcomeFixture(decisionReceipt, generatedAt);
  const decisionCard: DecisionCard = {
    ...localDecision,
    headline: `${failures.length}/8 candidate captions violate the 9:16 safe area; maximum measured overflow is ${maxViolation}px.`,
    baselineVersion: manifest.baseline,
    baselineDigest,
    candidateVersion: manifest.candidate,
    candidateDigest,
    experimentId,
    completedAt: generatedAt,
    policyName: loadedPolicy.policy.name,
    policyVersion: loadedPolicy.policy.version,
    policyHash: loadedPolicy.hash,
    datasetName: dataset.name,
    datasetHash,
    affectedAssets: failures.map((item) => item.clipId),
    diagnosis: failures.length > 0
      ? `The rc1 multiline path anchors caption blocks in the ${dataset.canvas.width}×${dataset.canvas.height} pre-transform space, then applies the portrait Y scale. Pixel diff on decoded ${dataset.output.width}×${dataset.output.height} output measures the resulting lower-edge overflow.`
      : "No caption safe-area violation was measured.",
    recommendedAction: failures.length > 0
      ? "Keep caption-compositor@0.1.0 in production. Move multiline anchoring to final portrait coordinates, then replay this locked eight-clip canary."
      : "Candidate is eligible for human promotion review.",
    mcpReceipts: [],
    grafanaEvidenceRefs: [],
    traceIds: [heroBaseline.traceId, heroCandidate.traceId],
    gitCommit: gitCommit(),
    geminiModel: "not-used — deterministic local Experiment Agent fallback",
    replayCommand: "make canary",
    provenance: "local/synthetic",
    synthetic: true,
    change,
    evidenceCasefile,
    canaryPack,
    canaryRun,
    decisionReceiptFingerprint: decisionReceipt.fingerprint,
    policyOwner: "deterministic-policy-evaluator",
    renderComparison: {
      baseline: { path: heroBaseline.renderPath, compositorPasses: heroBaseline.compositorPasses, p95DurationMs: round(baselineP95, 1) },
      candidate: { path: heroCandidate.renderPath, compositorPasses: heroCandidate.compositorPasses, p95DurationMs: round(candidateP95, 1) },
      candidateP95Improvement: baselineP95 === 0 ? 0 : round((baselineP95 - candidateP95) / baselineP95),
    },
    hero: {
      clipId: heroCandidate.clipId,
      baselineVideo: `/artifacts/${experimentId}/media/${heroCandidate.clipId}/baseline.mp4`,
      candidateVideo: `/artifacts/${experimentId}/media/${heroCandidate.clipId}/candidate.mp4`,
      baselinePoster: `/artifacts/${experimentId}/media/${heroCandidate.clipId}/baseline.png`,
      candidatePoster: `/artifacts/${experimentId}/media/${heroCandidate.clipId}/candidate.png`,
      baselineBounds: heroBaseline.captionBounds,
      candidateBounds: heroCandidate.captionBounds,
      safeArea: dataset.safeArea,
    },
  };
  validateDecisionArtifactShapes(decisionCard, evidenceCasefile, decisionReceipt, decisionOutcome);

  const summary = {
    experimentId,
    provenance: "local/synthetic",
    decision: decisionCard.decision,
    reason: decisionCard.reason,
    candidateFailures: failures.length,
    maximumViolationPx: maxViolation,
    baselineP95RenderDurationMs: round(baselineP95, 1),
    candidateP95RenderDurationMs: round(candidateP95, 1),
    candidateP95Improvement: baselineP95 === 0 ? 0 : round((baselineP95 - candidateP95) / baselineP95),
    runCoverage: metrics.length,
    expectedCoverage: loadedPolicy.policy.requiredRunCoverage,
    datasetHash,
    policyHash: loadedPolicy.hash,
    manifestHash,
    evidenceBundleHash: evidenceBundle.localReceipt?.bundleHash,
    evidenceCasefileFingerprint: evidenceCasefile.fingerprint,
    canaryPack: `${canaryPack.id}@${canaryPack.version}`,
    canaryRunFingerprint: canaryRun.fingerprint,
    decisionReceiptFingerprint: decisionReceipt.fingerprint,
    outcomeObservationStatus: decisionOutcome.observationStatus,
  };

  await Promise.all([
    writeJson(join(originalsDir, "inventory.json"), { dataset: dataset.name, datasetHash, generatedAt, assets: originalInventory }),
    writeJson(join(artifactDir, "metrics.json"), metrics),
    writeFile(join(artifactDir, "metrics.prom"), prometheusText(metrics), "utf8"),
    writeFile(join(artifactDir, "logs.jsonl"), `${logs.map((log) => JSON.stringify(log)).join("\n")}\n`, "utf8"),
    writeJson(join(artifactDir, "traces.json"), traces),
    writeJson(join(artifactDir, "evidence-bundle.json"), evidenceBundle),
    writeJson(join(artifactDir, "change.json"), change),
    writeJson(join(artifactDir, "evidence-casefile.json"), evidenceCasefile),
    writeJson(join(artifactDir, "canary-pack.json"), canaryPack),
    writeJson(join(artifactDir, "canary-run.json"), canaryRun),
    writeJson(join(artifactDir, "policy-evaluation-local.json"), localDecision),
    writeJson(join(artifactDir, "policy-evaluation-mcp-required.json"), mcpRequiredDecision),
    writeJson(join(artifactDir, "decision-receipt.json"), decisionReceipt),
    writeJson(join(artifactDir, "decision-outcome.fixture.json"), decisionOutcome),
    writeJson(join(artifactDir, "decision-card.json"), decisionCard),
    writeJson(join(artifactDir, "summary.json"), summary),
  ]);
  await writeJson(join(artifactDir, "artifact-index.json"), {
    experimentId,
    provenance: "local/synthetic",
    generatedAt,
    files: await artifactIndex(artifactDir),
  });
  const latestDir = join(projectRoot, "artifacts", "latest");
  await mkdir(latestDir, { recursive: true });
  for (const file of ["decision-card.json", "change.json", "evidence-bundle.json", "evidence-casefile.json", "canary-pack.json", "canary-run.json", "decision-receipt.json", "decision-outcome.fixture.json", "summary.json", "policy-evaluation-mcp-required.json", "artifact-index.json"]) {
    await copyFile(join(artifactDir, file), join(latestDir, file));
  }
  return { experimentId, artifactDir, decisionCard, evidenceBundle, evidenceCasefile, decisionReceipt, decisionOutcome };
}
