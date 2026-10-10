import { Pool, PoolClient } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Exécute une série de requêtes dans une transaction scopée à un client_id.
 * SET LOCAL app.current_client_id garantit (avec RLS activé, migration 002)
 * qu'aucune requête de ce bloc ne peut lire/écrire les données d'un autre tenant.
 */
export async function withTenant<T>(
  clientId: string,
  fn: (db: PoolClient) => Promise<T>
): Promise<T> {
  return withSetting("app.current_client_id", clientId, fn);
}

/**
 * Échappatoire explicite pour les rares requêtes légitimement cross-tenant :
 * routes /admin (protégées par ADMIN_API_KEY) et lookups de propriété du
 * worker (« à quel client appartient cette relance ? », avant de pouvoir
 * scoper). Ouvre les policies `admin_mode_*` de migrations/004_force_rls.sql.
 *
 * À n'utiliser QUE pour retrouver le client_id propriétaire ; tout le reste
 * du traitement doit repasser par withTenant().
 */
export async function withAdmin<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return withSetting("app.admin_mode", "on", fn);
}

async function withSetting<T>(
  setting: string,
  value: string,
  fn: (db: PoolClient) => Promise<T>
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config($1, $2, true)", [setting, value]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
