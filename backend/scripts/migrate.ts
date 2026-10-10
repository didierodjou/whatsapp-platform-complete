import "dotenv/config";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rowCount: migrationCount } = await pool.query(`SELECT 1 FROM schema_migrations LIMIT 1`);
  if (!migrationCount) {
    const { rows: legacy } = await pool.query(`
      SELECT
        to_regclass('public.sector_profiles') IS NOT NULL AS has_schema,
        EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_contacts') AS has_rls,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'clients' AND column_name = 'google_oauth_tokens' AND data_type = 'text'
        ) AS has_encryption
    `);
    const state = legacy[0];
    if (state.has_schema) await pool.query(`INSERT INTO schema_migrations (filename) VALUES ('001_init.sql')`);
    if (state.has_rls) await pool.query(`INSERT INTO schema_migrations (filename) VALUES ('002_rls.sql')`);
    if (state.has_encryption) await pool.query(`INSERT INTO schema_migrations (filename) VALUES ('003_encrypt_sensitive_fields.sql')`);
  }

  for (const file of files) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE filename = $1`,
      [file]
    );
    if (rowCount) {
      console.log(`Migration déjà appliquée: ${file}`);
      continue;
    }

    console.log(`Application de la migration: ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
  console.log("Migrations terminées.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Échec migration:", err);
  process.exit(1);
});
