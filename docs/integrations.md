# External integration boundaries

The checked-in demo is deliberately complete without network access. Its evidence provenance is always `local/synthetic`; it does not claim cloud, MCP, ADK, Gemini, or hosted Grafana execution.

## Grafana MCP

[`src/adapters/grafana-adk.ts`](../src/adapters/grafana-adk.ts) uses `MCPToolset` from Google ADK against the hosted Streamable HTTP endpoint. It sends the stack-routing header, discovers tools at runtime, requires metric/log/trace capabilities, and records the exact server identity, tool name, arguments, raw result, result hash, receipt time, and returned trace IDs. The agent fails closed if any required category was not actually called.

[`src/adapters/grafana-oauth.ts`](../src/adapters/grafana-oauth.ts) implements the hosted service's interactive OAuth 2.1/PKCE flow. Registration, refresh token, access token, verifier, and discovery state are stored outside the repository in a `0600` file. The authorization callback binds only to `127.0.0.1` and validates OAuth state.

The older transport-independent boundary in [`src/adapters/grafana-mcp.ts`](../src/adapters/grafana-mcp.ts) remains available for the official self-hosted MCP server. Greenlight never invents a successful discovery, result, or receipt.

Without all three valid receipt categories, that path returns `HOLD — INSUFFICIENT EVIDENCE`. The local runner writes this negative-path result to `policy-evaluation-mcp-required.json` as proof of the guardrail; it is not a simulated MCP call.

Complete MCP receipts alone do not authorize promotion. If resilience is absent or suppressed, an otherwise passing candidate remains at `HOLD — INSUFFICIENT EVIDENCE`. Any failed blocking canary remains `HOLD`. The deterministic evaluator—not Grafana, Gemini, ADK, or narrative prose—owns these state transitions.

## OpenTelemetry / Grafana telemetry ingestion

[`src/adapters/otel.ts`](../src/adapters/otel.ts) contains an OTLP/HTTP JSON exporter boundary for traces, logs, and the five Greenlight metric instruments. It accepts only an explicit HTTPS endpoint (or localhost) and headers supplied by its caller. It is disabled in the local canary, which writes Prometheus exposition, JSONL logs, and JSON traces to the evidence directory.

`make agent-live` sends all three OTLP/HTTP JSON payloads before querying MCP and waits a bounded ingestion interval. A live environment still needs the Grafana-supplied OTLP endpoint/header, backend ingestion verification, and synthetic-only stack access.

## Gemini and Google ADK

[`src/adapters/google-adk-runtime.ts`](../src/adapters/google-adk-runtime.ts) executes real ADK `LlmAgent` and `Runner` instances with JSON-only Gemini responses. [`src/adapters/gemini.ts`](../src/adapters/gemini.ts) validates that the Experiment Agent chose known clips and copied the immutable policy hash. The Grafana Evidence Agent uses MCP results only to diagnose and recommend a replayable action after the deterministic verdict is fixed.

The implementation is locally verified with a fixed test model and a real local Streamable HTTP MCP server. A cloud-verified run still needs:

- a Google Cloud project and location;
- a supported Gemini model selected by the operator;
- deployment-specific credentials and IAM;
- a populated, ignored `.env` based on `.env.example`;
- a real `make agent-live` capture.

No live Gemini, Grafana Cloud, or Google Cloud call is claimed until the corresponding capture exists. No OpenAI or Anthropic model/API is invoked.
