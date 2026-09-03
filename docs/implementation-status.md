# Implementation status

Last updated: 2026-09-03.

## VERIFIED LIVE

- A credentialed Google ADK 2.0 `LlmAgent`/`Runner` Experiment Agent call executed against Vertex AI `gemini-2.5-flash` in project `greenlight-agentic-cinema`; its strict output schema returned the expected clip IDs and immutable policy hash.
- Grafana Cloud accepted an authenticated synthetic OTLP/HTTP JSON trace with HTTP 200. The operator independently confirmed exactly one matching `greenlight-canary` / `greenlight.otel.auth.smoke` trace in Traces Drilldown, with 1 ms duration and zero visible errors. The sanitized record is [`verification/grafana-otlp-smoke-2026-08-25.json`](verification/grafana-otlp-smoke-2026-08-25.json).
- The complete `make agent-live` orchestration executed on the development machine: Vertex AI planned all eight required clips, FFmpeg produced 16 baseline/candidate runs, all three telemetry signals were exported through authenticated OTLP/HTTP, hosted Grafana OAuth completed, and Google ADK discovered 118 hosted MCP tools.
- The Grafana Evidence Agent executed an exact four-call query plan through the hosted MCP endpoint. Both Prometheus queries, the Loki query, and the Tempo query returned non-empty data and generated result-hashed receipts. The returned traces include a paired baseline/candidate clip. The sanitized record is [`verification/live-adk-grafana-mcp-2026-08-25.json`](verification/live-adk-grafana-mcp-2026-08-25.json).
- The live Decision Card retained the deterministic `HOLD`: five of eight candidate captions violated the safe area by up to 61 px, while output validity and render-duration gates passed. Gemini only diagnosed the fixed verdict and recommended repairing `caption_layout`.
- A second credentialed live run provisioned a versioned Grafana dashboard and alert through MCP, exported a fresh canary, verified the named alert in `firing` state, repeated the four non-empty Prometheus/Loki/Tempo calls, found the dashboard, wrote a Decision Receipt-bound annotation, and generated a same-stack review link. All eight call results have separate hashes; the sanitized record is [`verification/live-alert-dashboard-mcp-2026-09-02.json`](verification/live-alert-dashboard-mcp-2026-09-02.json).
- The hardened 2026-09-03 live run used Vertex AI `gemini-2.5-pro`, correlated the highest failure exactly as clip `v02`, 61 px, trace `2fcd305798bf68e69c11317d946fba4d`, confirmed that trace in Tempo, re-hashed all four raw MCP proof results, and reran the deterministic policy in MCP-required mode with the same `HOLD/GATE_FAILED`. The public record is [`verification/live-alert-dashboard-mcp-2026-09-03.json`](verification/live-alert-dashboard-mcp-2026-09-03.json).
- Cloud KMS key version `decision-receipt-signer/cryptoKeyVersions/1` signed the exact final receipt, trusted policy, toolchain, and live-verification fingerprint. The exported P-256 public key independently verifies all eleven envelope checks with `npm run receipt:verify`.
- The final story-bound run completed at `2026-09-03T10:56:38.187Z` with Vertex AI `gemini-2.5-pro`; receipt `sha256:5c201fb351f634bdc6f06ab4575ba70dc13c5cdf26674d9a9fecb6f151b4e058` binds the same exact failure and live proof set used by the public Avery scenario.

## VERIFIED LOCAL

- Node/TypeScript runner and static Decision Card build; the deterministic local path remains network-independent.
- Eight original synthetic 16:9 cases with locked captions and edit plans.
- Actual PNG and H.264 MP4 generation through the installed FFmpeg.
- A baseline compositor that materializes two raster passes and a one-pass fused release candidate with a reproducible multiline coordinate-space defect.
- Pixel-diff caption bounds measured from decoded RGB frames against a no-caption render.
- FFprobe output dimensions/duration validity, run coverage, structured logs, trace-shaped evidence, Prometheus metrics, evidence hashing, and deterministic policy evaluation.
- Local/synthetic provenance and MCP-required insufficient-evidence guardrail.
- Typed `Change`, provenance-preserving `EvidenceItem`, `Signal`, `EvidenceResilienceAssessment`, `EvidenceCasefile`, versioned `CanaryPack`/`Invariant`, `CanaryRun`, immutable `DecisionReceipt`, and fixture-level `DecisionOutcome` records.
- Explicit categorical evidence support checks and content fingerprints; no confidence percentage or uncalibrated success probability is emitted.
- Applicability, paired baseline-pass/candidate-fail reproduction, full pack coverage, authoritative-within-fixture source counts, exact render-path/timing evidence, contradiction retention, recommendation eligibility, and suppression reasons.
- A versioned eight-case Canary Pack with four named invariants. The caption safe-area invariant blocks rc1; policy ignores any AI-style suggested action.
- Content-addressed decision receipts and an outcome fixture explicitly marked `fixture/not-observed`, with no production outcome claim.
- Local receipt hashes and MCP result hashes/receipt IDs are recomputed rather than trusted by shape; forged receipt tests fail closed.
- The policy is parsed as YAML by named keys and accepted only when it matches the code-anchored trusted SHA-256 hash.
- Vendored DejaVu Sans, its fontconfig file, and the exact FFmpeg/FFprobe binaries are fingerprinted into the experiment and Decision Receipt.
- Expanded accessible Decision Card evidence details, workflow relevance, support checks, contradiction, reproduction, named invariants, deterministic policy owner, and receipt fingerprint while retaining the media comparison.
- A fictional operator context now makes the decision concrete: Avery Morgan, Media Platform Lead at fictional Loopline Studios, reviews an automated dependency PR before a large render queue. The story context is separate from policy inputs and is explicitly labelled synthetic.
- Three linked public incident cards establish that black-frame, cloud-render timeout, and subtitle-positioning failures are documented categories. They are explicitly context-only and never enter the evidence casefile or verdict.

Exact latest measurements and verification commands are generated by `make canary` and documented in the engineering handoff; do not copy example performance numbers into prose.

## VERIFIED DEPLOYMENT

- The public Decision Card is deployed on Cloud Run at <https://greenlight-easase2aiq-ew.a.run.app>.
- Revision `greenlight-00007-qbg` serves 100% of traffic with the story-bound 2026-09-03 signed artifact set. The container verifies and packages that exact prebuilt run instead of creating a different time-dependent canary during `docker build`.
- Public checks returned 200 for `/`, `/health`, the signed Decision Card, live-verification record, KMS envelope, and 1080×1920 hero media. Desktop and 390 px browser inspection showed no horizontal overflow and both videos reached `readyState=4`.
- `/health` is the canonical application health endpoint. `/healthz` intentionally remains unclaimed so local behavior matches the 404 returned by Cloud Run's reserved platform path.
- Public checks confirmed the Decision Card, generated media, decision receipt, and sanitized live-verification artifact are reachable without credentials; no raw token, authorization header, password, or secret field is present in the public payloads.
- Desktop and 390 px responsive browser inspection confirmed the complete decision flow renders without horizontal overflow.

The credentialed orchestration is verified from the development machine, not from an unattended hosted workload. `authoritative: true` in local casefiles means authoritative for this repository-owned fixture only; it does not mean independent upstream confirmation.

## NOT IMPLEMENTED

- Cloud Run Jobs and Firestore/GCS persistence; the current public web deployment intentionally serves a build-time reproducible fixture and sanitized verification rather than running credentialed MCP OAuth inside an unattended service.
- Changelog polling, generated creative media during canaries, social publishing, multi-pipeline support, or subjective LLM QA.
- Public upload of the submission video. The approved edit and its generated media remain local and are intentionally excluded from Git.
- Observed production outcomes, historical confidence calibration, source reliability scoring, or third-party change collection.
