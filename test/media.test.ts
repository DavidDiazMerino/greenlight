import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderNoCaption, renderVariant, runMediaQa } from "../src/media.ts";
import type { Dataset } from "../src/types.ts";
import { projectRoot, readJson } from "../src/util.ts";

test("real FFmpeg paths preserve valid output while decoded pixels catch the rc1 defect", async () => {
  const source = await readJson<Dataset>(join(projectRoot, "dataset", "vertical-social-v1.json"));
  const selected = source.clips.find((clip) => clip.id === "v04");
  assert.ok(selected);
  const clip = { ...selected, durationSeconds: 0.4 };
  const dataset = { ...source, clips: [clip] };
  const root = await mkdtemp(join(tmpdir(), "greenlight-media-test-"));
  try {
    const noCaptionPath = await renderNoCaption(clip, dataset, root);
    const baseline = await renderVariant(clip, dataset, "baseline", root);
    const candidate = await renderVariant(clip, dataset, "candidate", root);
    const baselineQa = runMediaQa({
      experimentId: "integration-test",
      clip,
      dataset,
      variant: "baseline",
      noCaptionPath,
      posterPath: baseline.poster,
      videoPath: baseline.video,
      renderDurationMs: baseline.renderDurationMs,
      renderPath: baseline.renderPath,
      compositorPasses: baseline.compositorPasses,
    });
    const candidateQa = runMediaQa({
      experimentId: "integration-test",
      clip,
      dataset,
      variant: "candidate",
      noCaptionPath,
      posterPath: candidate.poster,
      videoPath: candidate.video,
      renderDurationMs: candidate.renderDurationMs,
      renderPath: candidate.renderPath,
      compositorPasses: candidate.compositorPasses,
    });

    assert.equal((await stat(baseline.video)).size > 0, true);
    assert.equal((await stat(candidate.video)).size > 0, true);
    assert.deepEqual(
      { path: baseline.renderPath, passes: baseline.compositorPasses, valid: baselineQa.outputValid, safe: baselineQa.safeAreaPass },
      { path: "baseline-multipass", passes: 2, valid: true, safe: true },
    );
    assert.deepEqual(
      { path: candidate.renderPath, passes: candidate.compositorPasses, valid: candidateQa.outputValid, safe: candidateQa.safeAreaPass, violation: candidateQa.violationPx },
      { path: "candidate-fused", passes: 1, valid: true, safe: false, violation: 61 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
