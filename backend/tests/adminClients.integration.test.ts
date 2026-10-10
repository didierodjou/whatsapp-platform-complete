import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";

// Les queues BullMQ ouvrent une connexion Redis dès l'import du routeur admin :
// on les simule pour tester les routes sans dépendre de Redis.
vi.mock("../src/scheduler/queues", () => ({
  relancesQueue: { getJobCounts: async () => ({ waiting: 0 }) },
  rappelsQueue: { getJobCounts: async () => ({ waiting: 0 }) },
  redisConnection: {},
  scheduleRecurringScans: async () => {},
}));

vi.mock("../src/rag/embed", () => ({
  embed: async () => Array.from({ length: 1024 }, () => 0),
  embedBatch: async (t: string[]) => t.map(() => Array.from({ length: 1024 }, () => 0)),
  EMBEDDING_DIMENSIONS: 1024,
}));

import { pool } from "../src/db/pool";
import { adminRouter } from "../src/admin/routes";
import { errorHandler } from "../src/utils/asyncRoute";

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "";
const NUM = "+33930000001";

const dbReady = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const suite = dbReady && ADMIN_KEY ? describe : describe.skip;

suite("Routes admin — archivage et suppression d'un client", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = $1`, [NUM]);

    const app = express();
    app.use(express.json());
    app.use("/admin", adminRouter);
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = $1`, [NUM]);
    await pool.end();
  });

  const appel = (chemin: string, init: RequestInit = {}, avecCle = true) =>
    fetch(`${baseUrl}${chemin}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(avecCle ? { "x-admin-key": ADMIN_KEY } : {}),
        ...(init.headers ?? {}),
      },
    });

  /** Client de test avec un contact, une conversation et un chunk. */
  async function creerClientComplet(): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO clients (sector_profile_id, nom_entreprise, whatsapp_business_number, statut)
       VALUES ((SELECT id FROM sector_profiles WHERE nom_secteur = 'restaurant'),
               'Client Jetable Admin', $1, 'actif')
       RETURNING id`,
      [NUM]
    );
    const id = rows[0].id;
    const contact = await pool.query(
      `INSERT INTO contacts (client_id, whatsapp_number) VALUES ($1, $2) RETURNING id`,
      [id, "+33933333333"]
    );
    await pool.query(`INSERT INTO conversations (contact_id, role, contenu) VALUES ($1, 'user', 'coucou')`, [
      contact.rows[0].id,
    ]);
    await pool.query(
      `INSERT INTO knowledge_base_chunks (client_id, contenu, embedding, source) VALUES ($1, $2, $3, $4)`,
      [id, "chunk jetable", JSON.stringify(Array.from({ length: 1024 }, () => 0)), "test"]
    );
    return id;
  }

  it("refuse toute opération sans la clé admin", async () => {
    const res = await appel("/admin/clients/00000000-0000-0000-0000-000000000000", { method: "DELETE" }, false);
    expect(res.status).toBe(401);
  });

  it("archiver = statut 'suspendu', sans perdre la moindre donnée", async () => {
    const id = await creerClientComplet();

    const res = await appel(`/admin/clients/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "suspendu" }),
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT c.statut,
              (SELECT count(*)::int FROM contacts ct WHERE ct.client_id = c.id) AS contacts,
              (SELECT count(*)::int FROM knowledge_base_chunks k WHERE k.client_id = c.id) AS chunks
       FROM clients c WHERE c.id = $1`,
      [id]
    );
    expect(rows[0]).toMatchObject({ statut: "suspendu", contacts: 1, chunks: 1 });

    // ...et l'archivage est réversible
    await appel(`/admin/clients/${id}`, { method: "PATCH", body: JSON.stringify({ statut: "actif" }) });
    const apres = await pool.query(`SELECT statut FROM clients WHERE id = $1`, [id]);
    expect(apres.rows[0].statut).toBe("actif");

    await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
  });

  it("supprimer efface le client et toutes ses données liées, en les décomptant", async () => {
    const id = await creerClientComplet();

    const res = await appel(`/admin/clients/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statut).toBe("supprime");
    expect(body.nom_entreprise).toBe("Client Jetable Admin");
    expect(body.donnees_supprimees).toMatchObject({
      contacts: 1,
      conversations: 1,
      chunks: 1,
    });

    // Cascade effective : plus rien ne subsiste
    const restes = await pool.query(
      `SELECT (SELECT count(*)::int FROM clients WHERE id = $1) AS clients,
              (SELECT count(*)::int FROM contacts WHERE client_id = $1) AS contacts,
              (SELECT count(*)::int FROM knowledge_base_chunks WHERE client_id = $1) AS chunks`,
      [id]
    );
    expect(restes.rows[0]).toMatchObject({ clients: 0, contacts: 0, chunks: 0 });
  });

  it("supprimer un client inexistant renvoie 404 sans casser le serveur", async () => {
    const res = await appel("/admin/clients/00000000-0000-0000-0000-000000000000", { method: "DELETE" });
    expect(res.status).toBe(404);

    // Le serveur répond toujours juste après
    const suivant = await appel("/admin/clients");
    expect(suivant.status).toBe(200);
  });

  it("un identifiant mal formé renvoie 400, pas un crash", async () => {
    const res = await appel("/admin/clients/pas-un-uuid", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await appel("/admin/clients")).status).toBe(200);
  });
});
