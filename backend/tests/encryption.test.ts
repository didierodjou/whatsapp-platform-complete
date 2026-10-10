import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import { encryptJSON, decryptJSON } from "../src/utils/encryption";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
});

describe("encryptJSON / decryptJSON — chiffrement des tokens sensibles", () => {
  it("chiffre puis déchiffre un objet et retrouve la valeur exacte", () => {
    const original = { access_token: "abc123", refresh_token: "xyz789", expiry_date: 1234567890 };
    const encrypted = encryptJSON(original);
    expect(encrypted).not.toContain("abc123"); // jamais en clair dans la valeur stockée
    expect(decryptJSON(encrypted)).toEqual(original);
  });

  it("produit un chiffré différent à chaque appel (IV aléatoire)", () => {
    const value = { token: "same-value" };
    const a = encryptJSON(value);
    const b = encryptJSON(value);
    expect(a).not.toBe(b);
    expect(decryptJSON(a)).toEqual(decryptJSON(b));
  });

  it("retourne null pour une valeur absente", () => {
    expect(decryptJSON(null)).toBeNull();
    expect(decryptJSON(undefined)).toBeNull();
  });

  it("rejette une valeur altérée (intégrité GCM)", () => {
    const encrypted = encryptJSON({ token: "abc" });
    const corrupted = encrypted.slice(0, -4) + "abcd";
    expect(() => decryptJSON(corrupted)).toThrow();
  });
});
