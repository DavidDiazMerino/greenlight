# Greenlight implementation instructions

## Binding battle plan

1. Build a media-native deterministic release gate whose hero is a reproducible 9:16 caption safe-area regression, rather than generic observability.
2. Make the entire local path executable: original synthetic assets → baseline/candidate renders → pixel-based media QA → policy HOLD → Decision Card with evidence provenance.
3. Keep external integrations replaceable: genuine OpenTelemetry/Grafana/Gemini/ADK integration points must be represented in code and documented, but no fake receipts or fabricated live calls.

## Project rules

- The product brief at `/home/david/Documents/Ideas/plans/greenlight-hackathon-master-brief.md` is the product source of truth.
- Keep all project changes inside `/home/david/projects/greenlight`.
- Prefer the smallest dependency-free TypeScript/Node implementation that makes the local vertical slice real.
- The deterministic policy evaluator owns the verdict. Agents may select experiments and explain evidence, but never alter thresholds or invent evidence.
- Local fixtures must always be labelled `local/synthetic`; they must never claim Grafana MCP, Gemini, ADK, or cloud execution.
- Runtime code must not depend on OpenAI or Anthropic.
- All demo media must be generated locally from original synthetic geometry and text.
- Run tests, build the UI, execute the canary, and inspect generated artifacts before declaring the slice complete.
