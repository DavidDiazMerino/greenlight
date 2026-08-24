import type { CandidateManifest, Dataset, EvidenceKind, ExperimentSpec } from "../types.ts";
import type { EvidenceBundle, PolicyDecision } from "../types.ts";

export interface ExperimentPlannerContext {
  manifest: CandidateManifest;
  dataset: Dataset;
  baselineDigest: string;
  candidateDigest: string;
  policyHash: string;
  requiredEvidence: EvidenceKind[];
}

export interface ExperimentPlanner {
  readonly identity: string;
  plan(context: ExperimentPlannerContext): Promise<ExperimentSpec>;
}

export class DeterministicExperimentPlanner implements ExperimentPlanner {
  readonly identity = "deterministic-local";

  async plan(context: ExperimentPlannerContext): Promise<ExperimentSpec> {
    const affectsCaptions = context.manifest.affectedStages.includes("caption_layout");
    const affectsReframe = context.manifest.affectedStages.includes("portrait_reframe");
    const selected = context.dataset.clips.filter((clip) =>
      affectsCaptions || (affectsReframe && clip.tags.includes("portrait-reframe"))
    );
    if (selected.length === 0) throw new Error("No canary clips match the affected pipeline stages");
    return {
      candidate: context.manifest.candidate,
      baselineDigest: context.baselineDigest,
      candidateDigest: context.candidateDigest,
      affectedStages: context.manifest.affectedStages,
      clipIds: selected.map((clip) => clip.id),
      policyHash: context.policyHash,
      requiredEvidence: context.requiredEvidence,
      planner: "deterministic-local",
    };
  }
}

/** Boundary implemented by the bundled Google ADK runtime or a test double. */
export interface GoogleAdkRuntime {
  runExperimentAgent(input: unknown): Promise<unknown>;
}

export class GeminiAdkExperimentPlanner implements ExperimentPlanner {
  readonly identity = "gemini-adk";
  private readonly runtime: GoogleAdkRuntime;
  readonly model: string;
  constructor(runtime: GoogleAdkRuntime, model: string) {
    this.runtime = runtime;
    this.model = model;
  }

  async plan(context: ExperimentPlannerContext): Promise<ExperimentSpec> {
    const raw = await this.runtime.runExperimentAgent({
      candidateManifest: context.manifest,
      pipelineInventory: ["input_validate", "portrait_reframe", "caption_layout", "render", "media_qa"],
      canaryCatalog: context.dataset.clips.map(({ id, tags }) => ({ id, tags })),
      immutablePolicy: { hash: context.policyHash, requiredEvidence: context.requiredEvidence },
      outputSchema: "ExperimentSpec@1",
    });
    return validateExperimentSpec(raw, context);
  }
}

function validateExperimentSpec(value: unknown, context: ExperimentPlannerContext): ExperimentSpec {
  if (!value || typeof value !== "object") throw new Error("Gemini/ADK returned no ExperimentSpec object");
  const item = value as Record<string, unknown>;
  const allowed = new Set(context.dataset.clips.map((clip) => clip.id));
  const clipIds = Array.isArray(item.clipIds) ? item.clipIds.filter((id): id is string => typeof id === "string") : [];
  if (clipIds.length === 0 || clipIds.some((id) => !allowed.has(id))) throw new Error("Gemini/ADK selected unknown or empty clip IDs");
  if (item.policyHash !== context.policyHash) throw new Error("Gemini/ADK attempted to change the immutable policy hash");
  return {
    candidate: context.manifest.candidate,
    baselineDigest: context.baselineDigest,
    candidateDigest: context.candidateDigest,
    affectedStages: context.manifest.affectedStages,
    clipIds,
    policyHash: context.policyHash,
    requiredEvidence: context.requiredEvidence,
    planner: "gemini-adk",
  };
}

export interface DecisionNarrative {
  diagnosis: string;
  recommendedAction: string;
}

export interface GoogleAdkDecisionRuntime {
  explainDecision(input: unknown): Promise<unknown>;
}

/** A real Evidence & Decision Agent may explain, but cannot replace, the mechanical verdict. */
export class GeminiAdkDecisionExplainer {
  private readonly runtime: GoogleAdkDecisionRuntime;
  readonly model: string;
  constructor(runtime: GoogleAdkDecisionRuntime, model: string) {
    this.runtime = runtime;
    this.model = model;
  }

  async explain(bundle: EvidenceBundle, decision: PolicyDecision): Promise<DecisionNarrative> {
    if (bundle.provenance !== "grafana-mcp" || bundle.mcpReceipts.length < 3) {
      throw new Error("Evidence & Decision Agent requires a receipt-complete Grafana MCP EvidenceBundle");
    }
    const raw = await this.runtime.explainDecision({
      immutableVerdict: decision,
      evidence: bundle,
      instruction: "Explain the measured cause for a post-production supervisor and propose a replayable corrective action. Do not change the verdict or thresholds.",
      outputSchema: "DecisionNarrative@1",
    });
    if (!raw || typeof raw !== "object") throw new Error("Gemini/ADK returned no DecisionNarrative object");
    const value = raw as Record<string, unknown>;
    if (typeof value.diagnosis !== "string" || typeof value.recommendedAction !== "string") {
      throw new Error("Gemini/ADK returned an invalid DecisionNarrative");
    }
    return { diagnosis: value.diagnosis, recommendedAction: value.recommendedAction };
  }
}
