import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "@/lib/crypto/tokens";

describe("token encryption", () => {
  it("round-trips and produces distinct ciphertexts", () => {
    const a = encryptSecret("1//refresh-token");
    const b = encryptSecret("1//refresh-token");
    expect(a).not.toEqual(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(decryptSecret(a)).toBe("1//refresh-token");
    expect(decryptSecret(b)).toBe("1//refresh-token");
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("secret");
    const parts = enc.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects unknown formats", () => {
    expect(() => decryptSecret("plain")).toThrow(/format/);
  });
});
