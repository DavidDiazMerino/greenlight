import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { signDecisionReceiptWithKms } from "../src/kms-signer.ts";
import { verifyKmsSignatureEnvelope, type KmsSignaturePayload } from "../src/kms-envelope.ts";
import type { DecisionCard, DecisionReceipt } from "../src/types.ts";
import { fingerprint, projectRoot, readJson, writeJson } from "../src/util.ts";
import { TRUSTED_POLICY_HASH } from "../src/policy.ts";

const keyVersion = process.env.GREENLIGHT_KMS_KEY_VERSION ?? "projects/greenlight-agentic-cinema/locations/global/keyRings/greenlight-release-trust/cryptoKeys/decision-receipt-signer/cryptoKeyVersions/1";
const publicKeyRelativePath = "policy/trust/decision-receipt-public-key.pem";
const publicKeyPath = join(projectRoot, publicKeyRelativePath);
const envelopePath = join(projectRoot, "docs", "verification", "kms-decision-receipt-signature.json");
const receipt = await readJson<DecisionReceipt>(join(projectRoot, "artifacts", "latest", "decision-receipt.json"));
const card = await readJson<DecisionCard>(join(projectRoot, "artifacts", "latest", "decision-card.json"));
const liveVerificationPath = join(projectRoot, "docs", "verification", "live-alert-dashboard-mcp-2026-09-03.json");
const liveVerification = JSON.parse(await readFile(liveVerificationPath, "utf8"));

if (card.decisionReceiptFingerprint !== receipt.fingerprint) throw new Error("Decision Card and receipt fingerprints differ");
if (liveVerification.experimentId !== card.experimentId) throw new Error("Live verification and Decision Card experiment IDs differ");
if (liveVerification.decision?.decisionReceiptFingerprint !== receipt.fingerprint) {
  throw new Error("Live verification and local Decision Receipt fingerprints differ");
}
if (receipt.policy.hash !== TRUSTED_POLICY_HASH) throw new Error("Refusing to sign a receipt with an unauthorized policy hash");
if (fingerprint(card.toolchain) !== receipt.commitments.toolchain) throw new Error("Refusing to sign a receipt with an uncommitted toolchain");

const payload: KmsSignaturePayload = {
  schemaVersion: "1.0",
  payloadType: "greenlight-decision-receipt",
  signedAt: new Date().toISOString(),
  experimentId: card.experimentId,
  gitCommit: card.gitCommit,
  decisionReceipt: receipt,
  toolchain: card.toolchain,
  liveVerificationFingerprint: fingerprint(liveVerification),
};
const { envelope, publicKeyPem } = await signDecisionReceiptWithKms({ payload, keyVersion, publicKeyPath: publicKeyRelativePath });
const verification = verifyKmsSignatureEnvelope(envelope, publicKeyPem);
if (!verification.valid) throw new Error(`Local KMS signature verification failed: ${JSON.stringify(verification.checks)}`);
await mkdir(dirname(publicKeyPath), { recursive: true });
await writeFile(publicKeyPath, publicKeyPem, { encoding: "utf8", mode: 0o644 });
await writeJson(envelopePath, envelope);
process.stdout.write(`Signed ${receipt.fingerprint} with ${keyVersion}\nEnvelope: ${envelopePath}\nPublic key: ${publicKeyPath}\n`);
