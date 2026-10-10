import crypto from "crypto";

/**
 * Chiffrement applicatif AES-256-GCM pour les champs sensibles stockés en
 * base (tokens OAuth Google, futurs tokens HubSpot par client, etc.).
 * S'ajoute au chiffrement au repos de Railway Postgres — défense en profondeur.
 *
 * ENCRYPTION_KEY doit être une chaîne hex de 64 caractères (32 octets).
 * Génère-en une avec : node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY manquant ou invalide dans .env — doit faire 64 caractères hex (32 octets). " +
        'Génère-en une avec: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, "hex");
}

/** Chiffre une valeur JS quelconque (sérialisée en JSON) en une chaîne stockable telle quelle. */
export function encryptJSON(value: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // recommandé pour GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const plaintext = Buffer.from(JSON.stringify(value), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format stocké : iv.authTag.ciphertext, chacun en base64
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

/** Déchiffre une valeur produite par encryptJSON. Retourne null si vide/absent. */
export function decryptJSON<T = unknown>(stored: string | null | undefined): T | null {
  if (!stored) return null;
  const key = getKey();
  const [ivB64, tagB64, dataB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Format de donnée chiffrée invalide (attendu: iv.authTag.ciphertext).");
  }

  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf-8")) as T;
}
