import { createPublicKey, verify } from "node:crypto";
import type { DecisionReceipt, RenderToolchain } from "./types.ts";
import { canonicalJson, fingerprint, sha256 } from "./util.ts";

export interface KmsSignaturePayload {
  schemaVersion: "1.0";
  payloadType: "greenlight-decision-receipt";
  signedAt: string;
  experimentId: string;
  gitCommit: string;
  decisionReceipt: DecisionReceipt;
  toolchain: RenderToolchain;
  liveVerificationFingerprint: string;
}

export interface KmsSignatureEnvelope {
  schemaVersion: "1.0";
  payload: KmsSignaturePayload;
  key: {
    resource: string;
    algorithm: "EC_SIGN_P256_SHA256";
    publicKeyPath: string;
    publicKeySha256: string;
  };
  signature: { encoding: "base64"; value: string };
  fingerprint: string;
}

export function kmsPayloadBytes(payload: KmsSignaturePayload): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}

export function createKmsSignatureEnvelope(input: {
  payload: KmsSignaturePayload;
  keyResource: string;
  publicKeyPath: string;
  publicKeyPem: string;
  signature: Buffer;
}): KmsSignatureEnvelope {
  const core = {
    schemaVersion: "1.0" as const,
    payload: input.payload,
    key: {
      resource: input.keyResource,
      algorithm: "EC_SIGN_P256_SHA256" as const,
      publicKeyPath: input.publicKeyPath,
      publicKeySha256: sha256(input.publicKeyPem),
    },
    signature: { encoding: "base64" as const, value: input.signature.toString("base64") },
  };
  return { ...core, fingerprint: fingerprint(core) };
}

export function verifyKmsSignatureEnvelope(envelope: KmsSignatureEnvelope, publicKeyPem: string): {
  valid: boolean;
  checks: Record<string, boolean>;
} {
  const receipt = envelope.payload.decisionReceipt;
  const committedReceipt = {
    schemaVersion: receipt.schemaVersion,
    provenance: receipt.provenance,
    commitments: receipt.commitments,
    canaryPack: receipt.canaryPack,
    policy: receipt.policy,
    verdict: receipt.verdict,
    reasons: [...receipt.reasons],
  };
  const { fingerprint: _fingerprint, ...envelopeCore } = envelope;
  let signature = false;
  try {
    signature = verify(
      "sha256",
      kmsPayloadBytes(envelope.payload),
      createPublicKey(publicKeyPem),
      Buffer.from(envelope.signature.value, "base64"),
    );
  } catch {
    signature = false;
  }
  const checks = {
    schema: envelope.schemaVersion === "1.0" && envelope.payload.schemaVersion === "1.0",
    payloadType: envelope.payload.payloadType === "greenlight-decision-receipt",
    algorithm: envelope.key.algorithm === "EC_SIGN_P256_SHA256",
    explicitKeyVersion: /\/cryptoKeyVersions\/\d+$/.test(envelope.key.resource),
    envelopeFingerprint: fingerprint(envelopeCore) === envelope.fingerprint,
    publicKeyFingerprint: sha256(publicKeyPem) === envelope.key.publicKeySha256,
    receiptFingerprint: fingerprint(committedReceipt) === receipt.fingerprint,
    receiptId: receipt.id === `decision-receipt:${receipt.fingerprint.slice(7, 23)}`,
    policyOwner: receipt.policy.owner === "deterministic-policy-evaluator",
    toolchainCommitment: fingerprint(envelope.payload.toolchain) === receipt.commitments.toolchain,
    signature,
  };
  return { valid: Object.values(checks).every(Boolean), checks };
}
