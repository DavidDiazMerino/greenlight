import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runCanary } from "./canary.ts";
import { runLiveIntegration } from "./live.ts";
import { projectRoot } from "./util.ts";

const command = process.argv[2];

if (command === "canary" || command === "demo-fixture") {
  const result = await runCanary();
  process.stdout.write(`\n${result.decisionCard.decision} · ${result.decisionCard.headline}\n`);
  process.stdout.write(`Provenance: ${result.decisionCard.provenance} (synthetic=${result.decisionCard.synthetic})\n`);
  process.stdout.write(`Coverage: ${result.decisionCard.evidenceCompleteness}\n`);
  process.stdout.write(`Artifacts: ${result.artifactDir}\n`);
} else if (command === "clean-generated") {
  const artifacts = join(projectRoot, "artifacts");
  const generated = join(projectRoot, "assets", "synthetic", "generated");
  await rm(artifacts, { recursive: true, force: true });
  await rm(generated, { recursive: true, force: true });
  process.stdout.write(`Removed generated outputs only:\n- ${artifacts}\n- ${generated}\n`);
} else if (command === "agent-live") {
  try {
    const result = await runLiveIntegration();
    process.stdout.write(`\n${result.decisionCard.decision} · live Gemini + Grafana MCP evidence captured\n`);
    process.stdout.write(`Capture: ${result.capturePath}\nDecision Card: ${result.cardPath}\n`);
  } catch (error) {
    process.stderr.write(`Greenlight live integration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write("Usage: node src/cli.ts canary|demo-fixture|agent-live|clean-generated\n");
  process.exitCode = 2;
}
