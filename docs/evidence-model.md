# Evidence model and decision receipts

Greenlight's local vertical slice follows one content-addressed chain:

```text
repository-owned Change
  → provenance-preserving EvidenceItems
  → measured Signal + categorical evidence support checks
  → Evidence Resilience + inspectable Casefile
  → versioned Canary Pack + invariant results
  → deterministic policy verdict
  → immutable Decision Receipt
  → local/synthetic unobserved Outcome fixture
```

Every local record is labelled `local/synthetic`. No field implies an upstream release, independent vulnerability report, Grafana MCP response, Gemini/ADK execution, cloud run, deployment, or production observation.

## Fingerprint boundaries

- An `EvidenceItem` fingerprints its extracted fact and exact provenance fields.
- A `Signal` fingerprints the sorted evidence records it cites and stores `evidence-assessment/v1` plus every categorical support check.
- An `EvidenceCasefile` fingerprints the change, signal, evidence, contradictions, applicability, reproduction, coverage, and recommendation eligibility.
- A `CanaryPack` fingerprints its dataset identity, eight named cases, and invariant definitions.
- A `CanaryRun` fingerprints exact baseline/candidate measurements and pass/fail results; completion time is metadata outside its content fingerprint.
- A `DecisionReceipt` commits to the full change fingerprint, casefile, signal, Canary Pack, Canary Run, policy hash, verdict, and reasons. `issuedAt` is metadata; identical committed decision inputs produce the same receipt fingerprint.

The receipt object is emitted with `immutable: true` and frozen in memory before serialization. The JSON file is content-addressed evidence, not a claim that the local filesystem is an append-only ledger.

## Evidence assessment and resilience

`evidence-assessment/v1` records each support check as `verified`, `contradicted`, or `missing`. Greenlight does not derive a percentage or present the assessment as a probability. The local rc1 signal records source authority within the fixture, provenance integrity, direct applicability, paired reproduction, full canary coverage, and the timing contradiction.

The resilience evaluator requires:

- at least one authoritative supporting source;
- the actual component, version, and code path to apply;
- baseline pass plus candidate fail reproduction;
- all eight pack cases and sixteen paired runs;
- no unresolved blocking contradiction.

Every contradiction remains visible and conservatively suppresses recommendation eligibility. A blocking contradiction adds a stronger, additional suppression reason; any applicability/reproduction/coverage failure also adds a machine-readable reason. If delivery gates pass but eligibility is absent or suppressed, policy returns `HOLD — INSUFFICIENT EVIDENCE`, never `PROMOTE`.

## Authority boundary

The policy evaluator consumes evidence eligibility and Canary Run results but ignores agent-style action suggestions. Its order is conservative:

1. incomplete or invalid provenance/coverage → `HOLD — INSUFFICIENT EVIDENCE`;
2. invalid output → `REJECT`;
3. failed hard gate or blocking invariant → `HOLD`;
4. missing/suppressed recommendation eligibility → `HOLD — INSUFFICIENT EVIDENCE`;
5. complete eligible evidence and all hard gates passing → `PROMOTE` for human action.

The checked-in rc1 follows branch 3 because `caption-safe-area-9x16` fails on v02, v03, v04, v05, and v07.

## Outcome fixture

`decision-outcome.fixture.json` exists only to make the future outcome contract inspectable. It always says:

- `provenance: local/synthetic`;
- `observationStatus: fixture/not-observed`;
- `observedAt: null`;
- `result: unknown`.

It must not be used for calibration or described as evidence that a real deployment was prevented.
