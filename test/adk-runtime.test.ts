import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseLlm, type BaseLlmConnection, type LlmResponse } from "@google/adk";
import { GoogleAdkAgentRuntime, parseAdkJsonResponse } from "../src/adapters/google-adk-runtime.ts";

class FixedJsonModel extends BaseLlm {
  private readonly value: unknown;
  constructor(value: unknown) {
    super({ model: "greenlight-fixed-json-test-model" });
    this.value = value;
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { content: { role: "model", parts: [{ text: JSON.stringify(this.value) }] } };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("Live connections are outside this deterministic test");
  }
}

test("the bundled Google ADK LlmAgent and Runner execute the structured experiment path", async () => {
  const expected = { clipIds: ["v01", "v02"], policyHash: "sha256:locked" };
  const runtime = new GoogleAdkAgentRuntime({
    model: new FixedJsonModel(expected),
  });

  assert.deepEqual(await runtime.runExperimentAgent({ outputSchema: "ExperimentSpec@1" }), expected);
});

test("the bundled Google ADK LlmAgent and Runner execute the structured decision path", async () => {
  const expected = { diagnosis: "Caption pixels cross the safe area.", recommendedAction: "Correct the transform and replay the canary." };
  const runtime = new GoogleAdkAgentRuntime({
    model: new FixedJsonModel(expected),
  });

  assert.deepEqual(await runtime.explainDecision({ immutableVerdict: "HOLD" }), expected);
});

test("ADK JSON parsing accepts a fenced object but rejects prose", () => {
  assert.deepEqual(parseAdkJsonResponse("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.throws(() => parseAdkJsonResponse("the verdict is HOLD"), /invalid JSON/);
});
