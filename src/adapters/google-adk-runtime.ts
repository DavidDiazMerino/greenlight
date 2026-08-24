import {
  InMemorySessionService,
  LlmAgent,
  Runner,
  type BaseLlm,
  isFinalResponse,
  stringifyContent,
  type BeforeModelCallback,
} from "@google/adk";
import type { GoogleAdkDecisionRuntime, GoogleAdkRuntime } from "./gemini.ts";

export interface GoogleAdkAgentRuntimeOptions {
  model: string | BaseLlm;
  appName?: string;
  /** Test seam: production callers leave this undefined so ADK calls Gemini. */
  beforeModelCallback?: BeforeModelCallback;
}

const EXPERIMENT_AGENT_INSTRUCTION = [
  "You are Greenlight's Experiment Agent for a vertical-video post-production release gate.",
  "Return one JSON object only.",
  "Select canary clipIds that exercise the affected stages.",
  "Copy policyHash exactly. Never change policy thresholds, required evidence, component versions, or digests.",
  "The deterministic policy evaluator, not this agent, owns the final release verdict.",
].join(" ");

const DECISION_AGENT_INSTRUCTION = [
  "You are Greenlight's Evidence & Decision Agent for a post-production supervisor.",
  "Return one JSON object only with string fields diagnosis and recommendedAction.",
  "Use only the supplied receipted evidence.",
  "Explain the measured cause and propose a replayable corrective action.",
  "Never alter, reinterpret, or override the immutable verdict or thresholds.",
].join(" ");

/**
 * Real Google Agent Development Kit runtime. The optional model callback exists
 * only so tests can exercise ADK's LlmAgent + Runner path without cloud secrets.
 */
export class GoogleAdkAgentRuntime implements GoogleAdkRuntime, GoogleAdkDecisionRuntime {
  readonly model: string;
  private readonly adkModel: string | BaseLlm;
  private readonly appName: string;
  private readonly beforeModelCallback?: BeforeModelCallback;

  constructor(options: GoogleAdkAgentRuntimeOptions) {
    const modelName = typeof options.model === "string" ? options.model : options.model.model;
    if (!modelName.trim()) throw new Error("Google ADK model must be configured");
    this.model = modelName;
    this.adkModel = options.model;
    this.appName = options.appName ?? "greenlight";
    this.beforeModelCallback = options.beforeModelCallback;
  }

  runExperimentAgent(input: unknown): Promise<unknown> {
    return this.runJsonAgent("greenlight_experiment_agent", EXPERIMENT_AGENT_INSTRUCTION, input);
  }

  explainDecision(input: unknown): Promise<unknown> {
    return this.runJsonAgent("greenlight_decision_agent", DECISION_AGENT_INSTRUCTION, input);
  }

  private async runJsonAgent(name: string, instruction: string, input: unknown): Promise<unknown> {
    const agent = new LlmAgent({
      name,
      description: "Greenlight structured agent powered by Gemini on Google Cloud",
      model: this.adkModel,
      instruction,
      includeContents: "none",
      generateContentConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
      beforeModelCallback: this.beforeModelCallback,
    });
    const runner = new Runner({
      appName: this.appName,
      agent,
      sessionService: new InMemorySessionService(),
    });

    let finalText = "";
    for await (const event of runner.runEphemeral({
      userId: "greenlight-operator",
      newMessage: {
        role: "user",
        parts: [{ text: JSON.stringify(input) }],
      },
    })) {
      if (event.errorCode || event.errorMessage) {
        throw new Error(`Google ADK agent failed: ${event.errorCode ?? "MODEL_ERROR"} ${event.errorMessage ?? ""}`.trim());
      }
      if (isFinalResponse(event)) finalText = stringifyContent(event);
    }

    if (!finalText.trim()) throw new Error("Google ADK agent returned no final response");
    return parseAdkJsonResponse(finalText);
  }
}

export function parseAdkJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Google ADK returned invalid JSON: ${detail}`);
  }
}
