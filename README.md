# Greenlight

> **Don’t track releases. Greenlight them.**

Greenlight is an evidence-backed release gate for post-production teams delivering vertical social video. It turns a repository-owned candidate change into provenance-grounded evidence, tests a versioned eight-clip Canary Pack, measures the pixels actually burned into the final 9:16 output, applies a committed delivery policy, and renders one auditable Decision Card.

This repository contains a complete, honest local vertical slice. Its generated evidence is labelled `local/synthetic`; it does **not** claim that Grafana MCP, Gemini, Google ADK, or cloud services were called.

## What the demo proves

`caption-compositor@0.1.0` lays captions out in the final 1080×1920 coordinate space and materializes a delivery-normalization pass after its portrait-caption raster. `caption-compositor@0.2.0-rc1` emits the delivery raster in one fused compositor pass but, for multiline captions, derives the block anchor in 1280×720 pre-transform coordinates and then applies the portrait Y scale. That real algorithmic defect pushes some caption pixels below the committed safe area.

The QA does not trust those declared coordinates. FFmpeg decodes a no-caption PNG and the captioned PNG to RGB, then Greenlight computes the changed-pixel bounding box. FFprobe independently checks each MP4's dimensions and duration. The policy in [`policy/vertical-delivery-v1.yaml`](policy/vertical-delivery-v1.yaml) makes a failed 100% safe-area gate a deterministic `HOLD`.

```text
8 original synthetic 16:9 MP4s + locked cues/EditPlans
  → baseline + candidate 1080×1920 MP4s
  → decoded-pixel media QA + ffprobe validity
  → typed Change → EvidenceItems → validated Signal + resilience casefile
  → versioned Canary Pack + named invariants
  → committed deterministic policy
  → HOLD + immutable Decision Receipt + unobserved outcome fixture
```

## Requirements

- Node.js 22.18+ (tested with the installed Node 24 runtime; native TypeScript stripping is used)
- FFmpeg and FFprobe with SVG, PNG, and H.264 support
- A modern browser

There are no runtime npm dependencies, database, auth layer, Docker image, or external media downloads.

## Run it

```bash
make install
make test
make canary
make build
make dev
```

Open `http://127.0.0.1:4173`. The canary writes its exact measurements under `artifacts/gl-local-*/` and refreshes `artifacts/latest/`. The runner emits real H.264 MP4s; it is not a still-only fallback.

Useful commands:

- `make canary`: regenerate originals, render both variants, run QA/policy, and write evidence.
- `make demo-fixture`: same deterministic local path, named for demo preparation.
- `make test`: verify provenance/fingerprints, evidence eligibility and suppression, policy non-override, receipt sensitivity, HOLD/PROMOTE/REJECT semantics, MCP guardrails, the layout defect, and experiment selection.
- `make build`: copy the browser application to `dist/public`.
- `make clean-generated`: remove only this project's generated `artifacts/` and `assets/synthetic/generated/` trees.

## Evidence layout

Each experiment contains:

- `media/<clip>/no-caption.png`, `baseline.{png,mp4}`, and `candidate.{png,mp4}`;
- per-variant QA JSON with both declared layout and measured pixel bounds;
- `metrics.json` and Prometheus exposition using the five `greenlight_*` metric names;
- `logs.jsonl` and `traces.json` with experiment, variant, clip, and compositor digest attributes;
- `evidence-bundle.json`, local and MCP-required policy evaluations, summary, ExperimentSpec, and Decision Card JSON.
- `change.json` and `evidence-casefile.json`, including the measured five-clip signal, evidence provenance, categorical support checks, applicability, reproduction, contradiction, and suppression state;
- `canary-pack.json` and `canary-run.json`, representing all eight clips and four named invariants with exact baseline/candidate gate measurements;
- `decision-receipt.json`, whose content fingerprint commits to the change, casefile/signal, Canary Pack and results, policy hash, verdict, and reasons;
- `decision-outcome.fixture.json`, explicitly marked `local/synthetic`, `fixture/not-observed`, and `result: unknown`—it is a contract example, not a production observation.

The eight source cases and asset rights are documented in [`dataset/vertical-social-v1.json`](dataset/vertical-social-v1.json) and [`assets/RIGHTS.md`](assets/RIGHTS.md). Verified source/original hashes are recorded in [`dataset/verified-hashes.json`](dataset/verified-hashes.json), while each run also writes `assets/synthetic/generated/inventory.json`.

## Evidence trust model

Local mode is for reproducible development and judging: complete local metrics/logs/traces plus a hashed local runner receipt may drive the visibly local Decision Card. It cannot be relabelled as MCP evidence.

The evidence model uses categorical `verified`, `contradicted`, and `missing` support checks. It deliberately emits no confidence percentage or success probability. Every run attaches the exact one-pass/two-pass path and p95 timing; because wall-clock timing is environment-dependent, a run that fails to reproduce the intended benefit is retained as a contradiction. That does not negate the directly reproduced pixel regression or change the blocking gate's `HOLD`. An authoritative flag means authoritative **within this repository-owned synthetic fixture**, never third-party truth.

Recommendation eligibility is conservative. Missing authority, contradictory evidence, an inapplicable component/version/code path, incomplete paired reproduction, or incomplete Canary Pack coverage suppresses promotion and produces `HOLD — INSUFFICIENT EVIDENCE` when the delivery gates otherwise pass. A failed blocking invariant also remains `HOLD`; an AI-style suggested action is not an input with decision authority.

Production/MCP-required mode is stricter. `provenance` must be `grafana-mcp`, and the bundle must contain valid receipts for metrics, logs, and traces; the trace receipt must carry a baseline/candidate pair. Missing receipts force exactly `HOLD — INSUFFICIENT EVIDENCE`. See [`docs/integrations.md`](docs/integrations.md).

## What real Gemini/ADK and Grafana still require

The code includes replaceable, runtime-independent boundaries, not pretend integrations:

- Grafana: connect an official Grafana MCP server through a real MCP client transport, discover its actual tools at runtime, explicitly bind advertised metric/log/trace tools, ingest real telemetry, and retain returned receipts.
- Gemini/ADK: configure a Google Cloud project/location/model, install and authenticate Google ADK, implement the injected `GoogleAdkRuntime`, and verify the structured response. The local fallback selects all eight clips because caption layout is affected.
- OpenTelemetry: supply a real HTTPS OTLP receiver/Collector endpoint and credentials, then verify metrics/logs/traces through the backend and MCP.

No OpenAI or Anthropic model/API is present in runtime code. Full boundaries and configuration gaps are in [`docs/integrations.md`](docs/integrations.md); verified versus unverified scope is in [`docs/implementation-status.md`](docs/implementation-status.md).

## Repository map

```text
dataset/       locked synthetic catalog, captions, manifest
policy/        immutable delivery gate
src/media.ts   original generation, both compositors, FFmpeg, pixel QA
src/evidence.ts typed provenance, resilience, Canary Pack, receipt/outcome builders
src/policy.ts  evidence validation and mechanical verdict
src/adapters/  Grafana MCP, OTLP, Gemini/ADK boundaries
src/web/       Decision Card application
test/          deterministic policy and planning tests
docs/          integration contract and implementation status
```

The domain contracts and fingerprint boundaries are documented in [`docs/evidence-model.md`](docs/evidence-model.md).

## License

MIT. All demo assets are original synthetic material generated by this repository.
