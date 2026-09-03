# Greenlight — test the dependency update against what you actually ship

**Track:** Grafana Labs

**Project type:** Web application and local agent workflow

**Repository:** https://github.com/DavidDiazMerino/greenlight

**Hosted project:** https://greenlight-easase2aiq-ew.a.run.app

**Demo video:** added after the final English edit is approved and uploaded

## Elevator pitch

Friday, 9:12. Avery Morgan, a fictional Media Platform Lead at Loopline Studios, receives an automated dependency PR just before thousands of campaign videos enter the render queue. The install succeeds, unit tests pass, every MP4 is valid, and the update promises faster rendering. She needs to decide whether it is safe to merge.

Greenlight tests the update against Avery's actual production workflow and catches the failure before delivery. Gemini plans a locked media canary and investigates the resulting Grafana alert across Prometheus metrics, Loki logs, and Tempo traces. Greenlight measures the actual decoded pixels, applies a deterministic delivery policy, and produces a receipted `HOLD` Decision Card. The agent can explain and annotate the evidence; it cannot change the verdict.

## What it does

Greenlight turns a candidate post-production change into one reproducible release investigation:

1. A Google ADK Experiment Agent selects every affected case from a versioned eight-clip Canary Pack.
2. FFmpeg generates baseline and candidate 1080×1920 H.264 masters from original synthetic geometry and text.
3. Pixel QA compares captioned frames with no-caption renders instead of trusting declared layout coordinates. FFprobe independently validates dimensions and duration.
4. Greenlight exports five media-specific metrics plus structured logs and traces through authenticated OTLP/HTTP.
5. A Grafana alert fires when candidate caption overflow is greater than zero.
6. A Gemini-powered Grafana Evidence Agent executes a bounded eight-call mission through the hosted Grafana Cloud MCP endpoint: investigate the firing alert; query Prometheus twice; query Loki; query Tempo; find the dashboard; annotate it with the fixed verdict and receipt fingerprint; and generate a review link.
7. The code-anchored policy evaluates the measured gates and emits `HOLD`. A content-addressed Decision Receipt binds the change, evidence casefile, Canary Pack, run, trusted policy hash, exact render toolchain, verdict, and reasons; Cloud KMS signs that receipt with an exported public key for independent verification.
8. The web Decision Card shows the baseline and failing candidate side by side, the measured pixel bounds, policy gates, provenance, receipts, and the Grafana investigation link.

## Why this matters

Vertical-video delivery failures are often discovered at the worst possible moment: during client review, platform QC, or after publication. A caption can be perfectly valid in project metadata and still be unsafe in the final encoded frame because of scaling, coordinate transforms, or compositor changes.

Greenlight tests the deliverable, not the intention. Its media-native canary is small enough to run before every release and strict enough to stop an unsafe master. The workflow is useful to post-production supervisors, finishing artists, pipeline engineers, and studios delivering high-volume social campaigns.

## The non-obvious idea

Most agent demos give the model more authority. Greenlight deliberately gives it less.

Gemini is valuable where interpretation and tool orchestration help: selecting affected experiments, correlating three observability signals, explaining root cause, and presenting evidence for a human. It is not the right authority for a contractual delivery threshold. The deterministic evaluator alone owns `PROMOTE`, `HOLD`, and `REJECT`, and tests prove that an AI-style recommendation cannot override a failed blocking invariant.

## How we built it

- **Google Cloud:** Vertex AI Gemini runs through `@google/adk` 2.0 using real `LlmAgent` and `Runner` execution. The final hardened mission used `gemini-2.5-pro`; Cloud KMS P-256 signs the resulting Decision Receipt.
- **Grafana Cloud:** the hosted Grafana MCP endpoint is connected through ADK's `MCPToolset` with OAuth 2.1/PKCE. The live agent discovered 119 tools and completed eight result-hashed calls.
- **Observability:** OTLP/HTTP exports metrics, logs, and traces. Prometheus, Loki, and Tempo results must all be non-empty and receipted for the MCP-required evidence path.
- **Media QA:** FFmpeg creates the original synthetic masters and both compositor variants; decoded RGB pixel differences locate the caption actually burned into output. FFprobe validates the final media container.
- **Policy and provenance:** TypeScript models changes, evidence items, categorical support checks, the Canary Pack, deterministic policy evaluation, recomputed local/MCP receipt proofs, and a KMS-signed immutable receipt.
- **Web experience:** a dependency-free, accessible Decision Card is served by Node and packaged in a Cloud Run-compatible container.

The only AI model invoked at runtime is Vertex AI Gemini. `@modelcontextprotocol/sdk` is the transport peer required by Google ADK's official MCP integration; it is not used as an AI model, AI API, or agent framework. No OpenAI or Anthropic runtime is used.

## Data and media sources

All eight decision-canary clips are generated locally from original synthetic geometry and original text owned by this project. The submission edit adds two disclosed MiniMax H3 text-to-video opening shots of fictional Avery, generated through Hermes/Nous/FAL without a real-person reference. No production client material or personal data is used.

The resulting evidence is always labelled `local/synthetic`. A real credentialed run exported that synthetic canary to Grafana Cloud and queried it back through MCP; this proves the integration without misrepresenting the fixture as production data. Raw credentials, OAuth tokens, OTLP headers, and raw MCP responses are excluded from the public repository. Sanitized receipts retain tool names, timestamps, result hashes, and success/data-presence checks.

## Technical challenge

The hardest part was preserving trust across two different kinds of evidence.

The local runner has complete knowledge of its synthetic media, but it cannot claim that data came from Grafana MCP. Conversely, a successful MCP call is not automatically useful evidence, and a dashboard annotation must never count as proof that a caption passed. Greenlight therefore separates:

- metric, log, and trace receipts that may satisfy the MCP evidence requirement;
- alert, dashboard-search, annotation, and navigation receipts that prove workflow closure;
- a deterministic policy receipt that alone records the release verdict.

Every network path fails closed. Missing tools, altered required queries, empty results, missing baseline/candidate trace pairing, or an absent firing alert prevent a successful live claim.

## What we learned

- Final-frame pixels are a stronger media-delivery contract than layout metadata.
- Agentic does not have to mean probabilistic governance. A bounded agent plus a deterministic evaluator can be both useful and auditable.
- Observability becomes part of the product when the alert starts a real investigation and the result returns to the dashboard for human review.
- Honest fixture labels increase credibility. Synthetic evidence can be reproducible and technically meaningful without being described as production evidence.
- Separating evidence receipts from operational receipts prevents a successful write-back from accidentally becoming justification for its own verdict.

## Accomplishments

- Reproduced a real coordinate-space caption bug: five of eight candidate clips exceed the safe area by 61 px while all baseline clips pass.
- Completed real Vertex AI Gemini and Google ADK runs.
- Exported all three OTLP signals and queried them back through Grafana Cloud MCP.
- Provisioned a versioned Grafana dashboard and firing alert through MCP.
- Completed the full alert-to-annotation workflow with eight independent result hashes.
- Correlated the exact highest-failure clip, 61 px overflow, and Tempo trace ID into the Grafana annotation, then re-hashed the raw MCP proofs and reproduced the local policy verdict in MCP-required mode.
- Signed the final Decision Receipt with Cloud KMS and shipped an offline verifier plus public key.
- Preserved deterministic policy sovereignty and content-addressed provenance throughout the workflow.
- Kept the complete local path network-independent and reproducible.

## What's next

The next production step is to connect Greenlight to a real post-production job queue while retaining the same policy and provenance boundary. Additional Canary Packs can cover title-safe areas, loudness, black frames, slate correctness, color-space mismatches, and platform-specific encodes. The Grafana integration can then route repeated failures into an incident workflow without ever giving the diagnosing model authority to approve delivery.

## Reproduce it

The network-independent path is:

```bash
make install
make typecheck
make test
make canary
make build
make dev
```

The credentialed path is documented in the repository and requires a Vertex AI-enabled Google Cloud project plus a Grafana Cloud stack. `make grafana-setup` provisions the dashboard and alert through MCP; `make agent-live` executes the complete mission.
