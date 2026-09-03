import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createDecisionReceipt } from "../src/evidence.ts";
import { createKmsSignatureEnvelope, kmsPayloadBytes, verifyKmsSignatureEnvelope, type KmsSignaturePayload } from "../src/kms-envelope.ts";
import type { Change, RenderToolchain } from "../src/types.ts";

const issuedAt = "2026-09-03T12:00:00.000Z";
const change: Change = {
  schemaVersion: "1.0",
  id: "change:test",
  component: "caption-compositor",
  fromVersion: "0.1.0",
  toVersion: "0.2.0-rc1",
  detectedAt: issuedAt,
  provenance: "local/synthetic",
  synthetic: true,
  sourceEvidenceIds: ["evidence:test"],
  affectedStages: ["caption_layout"],
  workflowImpact: "Synthetic test fixture.",
};
const toolchain: RenderToolchain = {
  font: { family: "DejaVu Sans", path: "assets/fonts/DejaVuSans.ttf", sha256: "sha256:font", fontConfigSha256: "sha256:font-config" },
  ffmpeg: { version: "ffmpeg test", binaryFingerprint: "sha256:ffmpeg" },
  ffprobe: { version: "ffprobe test", binaryFingerprint: "sha256:ffprobe" },
};

test("an exported P-256 public key independently verifies the signed receipt envelope", () => {
  const receipt = createDecisionReceipt({
    change,
    evidenceCasefileFingerprint: "sha256:casefile",
    signalFingerprint: "sha256:signal",
    canaryPackId: "vertical-social",
    canaryPackVersion: "1.0.0",
    canaryPackFingerprint: "sha256:pack",
    canaryRunFingerprint: "sha256:run",
    policyName: "vertical-delivery",
    policyVersion: "v1",
    policyHash: "sha256:policy",
    toolchain,
    verdict: "HOLD",
    reasons: ["GATE_FAILED"],
    issuedAt,
    provenance: "local/synthetic",
  });
  const payload: KmsSignaturePayload = {
    schemaVersion: "1.0",
    payloadType: "greenlight-decision-receipt",
    signedAt: issuedAt,
    experimentId: "gl-local-test",
    gitCommit: "test",
    decisionReceipt: receipt,
    toolchain,
    liveVerificationFingerprint: "sha256:live",
  };
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signature = sign("sha256", kmsPayloadBytes(payload), privateKey);
  const envelope = createKmsSignatureEnvelope({
    payload,
    keyResource: "projects/test/locations/global/keyRings/test/cryptoKeys/test/cryptoKeyVersions/1",
    publicKeyPath: "policy/trust/test.pem",
    publicKeyPem,
    signature,
  });

  const verified = verifyKmsSignatureEnvelope(envelope, publicKeyPem);
  assert.equal(verified.valid, true);
  assert.ok(Object.values(verified.checks).every(Boolean));

  const tampered = structuredClone(envelope);
  (tampered.payload.decisionReceipt as { verdict: string }).verdict = "PROMOTE";
  const rejected = verifyKmsSignatureEnvelope(tampered, publicKeyPem);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.checks.signature, false);
  assert.equal(rejected.checks.receiptFingerprint, false);
  assert.equal(rejected.checks.envelopeFingerprint, false);
});
