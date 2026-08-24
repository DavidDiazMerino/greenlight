# External integration boundaries

The checked-in demo is deliberately complete without network access. Its evidence provenance is always `local/synthetic`; it does not claim cloud, MCP, ADK, Gemini, or hosted Grafana execution.

## Grafana MCP

[`src/adapters/grafana-mcp.ts`](../src/adapters/grafana-mcp.ts) accepts an MCP transport supplied by the host. It lists the tools actually advertised by the connected Grafana MCP server, requires an explicit binding for metrics/logs/traces, calls only an advertised name, and records the exact server identity, tool name, query, result hash, receipt time, and trace IDs.

Greenlight intentionally does not invent tool names. A real integration must:

1. Install or connect the official Grafana MCP server outside this repository.
2. Authenticate it using the deployment's approved secret mechanism.
3. Implement `McpTransport` using the selected MCP client/runtime.
4. Inspect `discoverCapabilities()` and bind real advertised tools in `GrafanaToolBinding`.
5. Query aggregate metrics, failed-gate logs, and a paired baseline/candidate trace.
6. Construct an `EvidenceBundle` with `provenance: "grafana-mcp"`, `synthetic: false`, and all three receipts.
7. Build provenance-preserving `EvidenceItem` records from the returned facts, validate applicability/reproduction/coverage into an `EvidenceResilienceAssessment`, and retain contradictions rather than silently dropping them.
8. Call `evaluatePolicy(..., { requireMcp: true, resilience, canaryRun })`.

Without all three valid receipt categories, that path returns `HOLD — INSUFFICIENT EVIDENCE`. The local runner writes this negative-path result to `policy-evaluation-mcp-required.json` as proof of the guardrail; it is not a simulated MCP call.

Complete MCP receipts alone do not authorize promotion. If resilience is absent or suppressed, an otherwise passing candidate remains at `HOLD — INSUFFICIENT EVIDENCE`. Any failed blocking canary remains `HOLD`. The deterministic evaluator—not Grafana, Gemini, ADK, or narrative prose—owns these state transitions.

## OpenTelemetry / Grafana telemetry ingestion

[`src/adapters/otel.ts`](../src/adapters/otel.ts) contains an OTLP/HTTP JSON exporter boundary for traces, logs, and the five Greenlight metric instruments. It accepts only an explicit HTTPS endpoint (or localhost) and headers supplied by its caller. It is disabled in the local canary, which writes Prometheus exposition, JSONL logs, and JSON traces to the evidence directory.

A live environment still needs a configured OpenTelemetry Collector or compatible OTLP receiver, credentials injected without committing them, network verification, backend data-source configuration, and an end-to-end query through the Grafana MCP boundary.

## Gemini and Google ADK

[`src/adapters/gemini.ts`](../src/adapters/gemini.ts) separates `ExperimentPlanner` from its execution runtime. The deterministic fallback selects the locked canary catalog based on affected pipeline stages. The `GeminiAdkExperimentPlanner` accepts an injected `GoogleAdkRuntime`, sends the manifest/catalog/immutable policy hash, and validates that returned clip IDs exist and the policy hash was not changed. A separate `GeminiAdkDecisionExplainer` refuses non-MCP evidence and can only return diagnosis/action prose after the policy evaluator has fixed the verdict.

Real operation still needs:

- a Google Cloud project and location;
- a supported Gemini model selected by the operator;
- Google ADK installed and authenticated outside this dependency-free fixture;
- an implementation of `GoogleAdkRuntime.runExperimentAgent` backed by that ADK runtime;
- deployment-specific credentials and IAM;
- live verification of the structured result.

No Gemini or ADK call has been made by this repository. No OpenAI or Anthropic runtime exists in the project.
