import { createHash } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { createKmsSignatureEnvelope, kmsPayloadBytes, type KmsSignatureEnvelope, type KmsSignaturePayload } from "./kms-envelope.ts";

export async function signDecisionReceiptWithKms(options: {
  payload: KmsSignaturePayload;
  keyVersion: string;
  publicKeyPath: string;
  client?: KeyManagementServiceClient;
}): Promise<{ envelope: KmsSignatureEnvelope; publicKeyPem: string }> {
  if (!/\/cryptoKeyVersions\/\d+$/.test(options.keyVersion)) throw new Error("KMS keyVersion must identify an explicit cryptoKeyVersion");
  const client = options.client ?? new KeyManagementServiceClient();
  const bytes = kmsPayloadBytes(options.payload);
  const digest = createHash("sha256").update(bytes).digest();
  const [[publicKey], [signed]] = await Promise.all([
    client.getPublicKey({ name: options.keyVersion }),
    client.asymmetricSign({ name: options.keyVersion, digest: { sha256: digest } }),
  ]);
  if (!publicKey.pem || !signed.signature) throw new Error("Cloud KMS returned no public key or signature");
  const publicKeyPem = publicKey.pem;
  const envelope = createKmsSignatureEnvelope({
    payload: options.payload,
    keyResource: options.keyVersion,
    publicKeyPath: options.publicKeyPath,
    publicKeyPem,
    signature: Buffer.from(signed.signature as Uint8Array),
  });
  return { envelope, publicKeyPem };
}
