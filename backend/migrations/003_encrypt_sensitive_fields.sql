-- ============================================================
-- 003_encrypt_sensitive_fields.sql — les tokens OAuth stockés en
-- clair (JSONB) passent en TEXT chiffré (AES-256-GCM applicatif,
-- voir src/utils/encryption.ts). Le contenu n'est plus lisible
-- directement en SQL, uniquement via le code applicatif.
-- ============================================================

ALTER TABLE clients
  ALTER COLUMN google_oauth_tokens TYPE TEXT USING google_oauth_tokens::text;

COMMENT ON COLUMN clients.google_oauth_tokens IS
  'Chiffré applicativement (AES-256-GCM) — voir src/utils/encryption.ts. Ne jamais lire/écrire directement en SQL.';
