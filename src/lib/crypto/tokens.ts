import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEnv } from "@/lib/env";

/**
 * AES-256-GCM encryption for secrets at rest (Google refresh tokens).
 * Format: v1:<iv base64>:<auth tag base64>:<ciphertext base64>
 * The "v1" prefix allows key rotation by introducing v2 with a new key id.
 */
const VERSION = "v1";

function key(): Buffer {
  const raw = requireEnv("TOKEN_ENCRYPTION_KEY", "encrypts Google refresh tokens; generate with `openssl rand -base64 32`");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 of `openssl rand -base64 32`).");
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) throw new Error("Unrecognised encrypted secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
