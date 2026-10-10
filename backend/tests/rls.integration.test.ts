import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, withTenant, withAdmin } from "../src/db/pool";

/**
 * Vérifie que l'isolation multi-tenant tient au niveau base (RLS), et pas
 * seulement grâce aux `WHERE client_id = ...` applicatifs.
 *
 * Subtilité Postgres : un superutilisateur (et le propriétaire des tables
 * tant que FORCE ROW LEVEL SECURITY n'est pas posé) contourne toujours la
 * RLS. Le rôle du docker-compose local ÉTANT superutilisateur, on bascule
 * volontairement sur un rôle applicatif dédié (SET LOCAL ROLE) pour tester
 * ce que subira réellement le rôle de production.
 */

const ROLE = "rls_test_role";
const NUM_A = "+33920000001";
const NUM_B = "+33920000002";
const TABLES_RLS = [
  "contacts",
  "conversations",
  "rendez_vous",
  "relances_programmees",
  "knowledge_base_chunks",
  "escalades",
];

const dbReady = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const suite = dbReady ? describe : describe.skip;

suite("Isolation multi-tenant garantie par la RLS Postgres", () => {
  let clientA: string;
  let clientB: string;
  let contactB: string;

  beforeAll(async () => {
    await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = ANY($1)`, [
      [NUM_A, NUM_B],
    ]);

    const creer = async (nom: string, numero: string) =>
      (
        await pool.query(
          `INSERT INTO clients (sector_profile_id, nom_entreprise, whatsapp_business_number)
           VALUES ((SELECT id FROM sector_profiles WHERE nom_secteur = 'restaurant'), $1, $2)
           RETURNING id`,
          [nom, numero]
        )
      ).rows[0].id as string;

    clientA = await creer("Tenant A RLS", NUM_A);
    clientB = await creer("Tenant B RLS", NUM_B);

    await pool.query(`INSERT INTO contacts (client_id, whatsapp_number) VALUES ($1, $2)`, [
      clientA,
      "+33999000001",
    ]);
    contactB = (
      await pool.query(
        `INSERT INTO contacts (client_id, whatsapp_number) VALUES ($1, $2) RETURNING id`,
        [clientB, "+33999000002"]
      )
    ).rows[0].id;

    await pool.query(`DO $$ BEGIN
      CREATE ROLE ${ROLE} NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = ANY($1)`, [
      [NUM_A, NUM_B],
    ]);
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
    await pool.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`);
    await pool.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await pool.end();
  });

  /** Exécute des requêtes sous le rôle applicatif non-superutilisateur. */
  async function commeRoleApplicatif<T>(
    settings: Record<string, string>,
    fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<T>
  ): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(`SET LOCAL ROLE ${ROLE}`);
      for (const [cle, valeur] of Object.entries(settings)) {
        await db.query("SELECT set_config($1, $2, true)", [cle, valeur]);
      }
      return await fn((sql, params) => db.query(sql, params as any[]));
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  }

  it("les 6 tables métier ont bien FORCE ROW LEVEL SECURITY (migration 004 appliquée)", async () => {
    const { rows } = await pool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE relname = ANY($1)`,
      [TABLES_RLS]
    );
    expect(rows).toHaveLength(TABLES_RLS.length);
    for (const t of rows) {
      expect(t.relrowsecurity, `${t.relname} : RLS non activée`).toBe(true);
      expect(t.relforcerowsecurity, `${t.relname} : RLS non forcée`).toBe(true);
    }
  });

  it("sans app.current_client_id, aucune ligne métier n'est visible", async () => {
    const n = await commeRoleApplicatif({}, async (q) => {
      const { rows } = await q(`SELECT count(*)::int AS n FROM contacts`);
      return rows[0].n;
    });
    expect(n).toBe(0);
  });

  it("avec app.current_client_id, un tenant ne voit que ses propres lignes", async () => {
    const vus = await commeRoleApplicatif({ "app.current_client_id": clientA }, async (q) => {
      const { rows } = await q(`SELECT client_id FROM contacts`);
      return rows.map((r: any) => r.client_id);
    });
    expect(vus.length).toBeGreaterThan(0);
    expect(new Set(vus)).toEqual(new Set([clientA]));
    expect(vus).not.toContain(clientB);
  });

  it("un tenant ne peut pas non plus écrire dans les données d'un autre", async () => {
    await expect(
      commeRoleApplicatif({ "app.current_client_id": clientA }, (q) =>
        q(`INSERT INTO contacts (client_id, whatsapp_number) VALUES ($1, $2)`, [
          clientB,
          "+33999000003",
        ])
      )
    ).rejects.toThrow(/row-level security/i);

    // ...ni supprimer les lignes d'un autre tenant (0 ligne affectée, pas d'erreur)
    const supprimees = await commeRoleApplicatif(
      { "app.current_client_id": clientA },
      async (q) => (await q(`DELETE FROM contacts WHERE id = $1`, [contactB])).rowCount
    );
    expect(supprimees).toBe(0);
  });

  it("l'échappatoire admin (app.admin_mode) reste possible pour les lookups cross-tenant", async () => {
    const n = await commeRoleApplicatif({ "app.admin_mode": "on" }, async (q) => {
      const { rows } = await q(`SELECT count(*)::int AS n FROM contacts WHERE client_id = ANY($1)`, [
        [clientA, clientB],
      ]);
      return rows[0].n;
    });
    expect(n).toBe(2);
  });

  it("withTenant et withAdmin posent les bons réglages de session", async () => {
    const scope = await withTenant(clientA, async (db) => {
      const { rows } = await db.query(
        `SELECT current_setting('app.current_client_id', true) AS c`
      );
      return rows[0].c;
    });
    expect(scope).toBe(clientA);

    const admin = await withAdmin(async (db) => {
      const { rows } = await db.query(`SELECT current_setting('app.admin_mode', true) AS m`);
      return rows[0].m;
    });
    expect(admin).toBe("on");

    // Le réglage est bien LOCAL : il ne fuit pas sur la connexion suivante du pool
    const apres = await pool.query(`SELECT current_setting('app.admin_mode', true) AS m`);
    expect(apres.rows[0].m).not.toBe("on");
  });
});
