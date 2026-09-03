import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyKmsSignatureEnvelope, type KmsSignatureEnvelope } from "../src/kms-envelope.ts";
import { projectRoot, readJson } from "../src/util.ts";

const envelopePath = resolve(process.argv[2] ?? join(projectRoot, "docs", "verification", "kms-decision-receipt-signature.json"));
const envelope = await readJson<KmsSignatureEnvelope>(envelopePath);
const publicKeyPath = resolve(projectRoot, envelope.key.publicKeyPath);
const publicKeyPem = await readFile(publicKeyPath, "utf8");
const verification = verifyKmsSignatureEnvelope(envelope, publicKeyPem);
process.stdout.write(`${JSON.stringify({ envelopePath, publicKeyPath, ...verification }, null, 2)}\n`);
if (!verification.valid) process.exitCode = 1;
