import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { GeminiAdkExperimentPlanner } from "../src/adapters/gemini.ts";
import type { CandidateManifest, Dataset } from "../src/types.ts";
import { projectRoot, readJson } from "../src/util.ts";

test("Gemini cannot reduce the deterministic coverage floor for an affected stage", async () => {
  const [manifest, dataset] = await Promise.all([
    readJson<CandidateManifest>(join(projectRoot, "dataset", "candidate-manifest.json")),
    readJson<Dataset>(join(projectRoot, "dataset", "vertical-social-v1.json")),
  ]);
  const planner = new GeminiAdkExperimentPlanner({
    async runExperimentAgent() {
      return { clipIds: ["v01"], policyHash: "sha256:locked" };
    },
  }, "fixed-gemini-test");

  const spec = await planner.plan({
    manifest,
    dataset,
    baselineDigest: "sha256:baseline",
    candidateDigest: "sha256:candidate",
    policyHash: "sha256:locked",
    requiredEvidence: ["metrics", "logs", "traces"],
  });

  const allClipIds = dataset.clips.map((clip) => clip.id);
  assert.deepEqual(spec.proposedClipIds, ["v01"]);
  assert.deepEqual(spec.clipIds, allClipIds);
  assert.deepEqual(spec.coverageGuard.requiredClipIds, allClipIds);
  assert.deepEqual(spec.coverageGuard.addedClipIds, allClipIds.slice(1));
});
