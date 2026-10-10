import "dotenv/config";
import { Worker } from "bullmq";
import { redisConnection, relancesQueue, rappelsQueue } from "./queues";
import { pool, withTenant, withAdmin } from "../db/pool";
import { resolveClientByWhatsappNumber, buildSystemPrompt } from "../orchestrator/resolveClient";
import { converseWithClaude } from "../llm/converse";
import { sendWhatsappText } from "../integrations/whatsapp";
import { retrieveRelevantChunks, formatChunksForPrompt } from "../rag/retrieve";

const MAX_RELANCES = 2;

/**
 * Worker "relances" : reçoit un job "scan-relances" (répété toutes les
 * heures par scheduleRecurringScans), lit les relances à échéance en DB,
 * puis enfile un job "envoi" individuel par relance — chacun traité une
 * seule fois, même avec plusieurs instances de ce worker en parallèle.
 */
const relancesWorker = new Worker(
  "relances",
  async (job) => {
    if (job.name === "scan-relances") {
      const { rows: clients } = await pool.query(`SELECT id FROM clients WHERE statut != 'suspendu'`);
      for (const client of clients) {
        const { rows } = await withTenant(client.id, (db) =>
          db.query(
            `SELECT id FROM relances_programmees
             WHERE statut = 'en_attente' AND date_prevue <= now()`
          )
        );
        for (const relance of rows) {
          // clientId embarqué dans le job : évite un lookup cross-tenant côté envoi
          await relancesQueue.add("envoi-relance", { relanceId: relance.id, clientId: client.id });
        }
      }
      return;
    }

    if (job.name === "envoi-relance") {
      await traiterRelance(job.data.relanceId, job.data.clientId);
    }
  },
  { connection: redisConnection, concurrency: 5 }
);

async function traiterRelance(relanceId: string, clientIdFromJob?: string) {
  // Fallback withAdmin pour les jobs enfilés avant l'ajout de clientId au payload.
  const clientId =
    clientIdFromJob ??
    (
      await withAdmin((db) =>
        db.query(`SELECT client_id FROM relances_programmees WHERE id = $1`, [relanceId])
      )
    ).rows[0]?.client_id;
  if (!clientId) return;

  const { rows } = await withTenant(clientId, (db) =>
    db.query(
      `SELECT r.id, r.contact_id, r.client_id, r.sujet, r.nombre_envoyees,
              c.whatsapp_number, c.opt_in_marketing
       FROM relances_programmees r
       JOIN contacts c ON c.id = r.contact_id
       WHERE r.id = $1 AND r.statut = 'en_attente'`,
      [relanceId]
    )
  );
  const relance = rows[0];
  if (!relance) return; // déjà traitée entre-temps (idempotence)

  if (!relance.opt_in_marketing || relance.nombre_envoyees >= MAX_RELANCES) {
    await withTenant(clientId, (db) =>
      db.query(`UPDATE relances_programmees SET statut = 'stoppee' WHERE id = $1`, [relanceId])
    );
    return;
  }

  const clientRow = await pool.query(`SELECT whatsapp_business_number FROM clients WHERE id = $1`, [
    relance.client_id,
  ]);
  const client = await resolveClientByWhatsappNumber(clientRow.rows[0]?.whatsapp_business_number);
  if (!client) return;

  const chunks = await retrieveRelevantChunks(client.id, relance.sujet, 3);
  const message = await converseWithClaude({
    systemPrompt: buildSystemPrompt(client),
    ragContext: formatChunksForPrompt(chunks),
    history: [],
    userMessage: `[Génère un message de relance courte et non-insistante au sujet de: ${relance.sujet}. Rappelle que le contact peut répondre STOP pour ne plus être contacté.]`,
    client,
    contactId: relance.contact_id,
    contactWhatsappNumber: relance.whatsapp_number,
  });

  await sendWhatsappText(client, relance.whatsapp_number, message);
  await withTenant(client.id, (db) =>
    db.query(
      `UPDATE relances_programmees SET nombre_envoyees = nombre_envoyees + 1,
       statut = CASE WHEN nombre_envoyees + 1 >= $2 THEN 'terminee' ELSE 'en_attente' END,
       date_prevue = date_prevue + interval '48 hours'
       WHERE id = $1`,
      [relanceId, MAX_RELANCES]
    )
  );
}

/** Worker "rappels-rdv" : même logique scan -> job individuel -> envoi. */
const rappelsWorker = new Worker(
  "rappels-rdv",
  async (job) => {
    if (job.name === "scan-rappels") {
      const { rows: clients } = await pool.query(`SELECT id FROM clients WHERE statut != 'suspendu'`);
      for (const client of clients) {
        const { rows } = await withTenant(client.id, (db) =>
          db.query(
            `SELECT id FROM rendez_vous
             WHERE statut = 'confirme' AND rappel_envoye = false
               AND datetime BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'`
          )
        );
        for (const rdv of rows) {
          await rappelsQueue.add("envoi-rappel", { rdvId: rdv.id, clientId: client.id });
        }
      }
      return;
    }

    if (job.name === "envoi-rappel") {
      await traiterRappel(job.data.rdvId, job.data.clientId);
    }
  },
  { connection: redisConnection, concurrency: 5 }
);

async function traiterRappel(rdvId: string, clientIdFromJob?: string) {
  const clientId =
    clientIdFromJob ??
    (
      await withAdmin((db) =>
        db.query(`SELECT client_id FROM rendez_vous WHERE id = $1`, [rdvId])
      )
    ).rows[0]?.client_id;
  if (!clientId) return;

  const { rows } = await withTenant(clientId, (db) =>
    db.query(
      `SELECT rv.id, rv.datetime, rv.motif, rv.client_id, rv.rappel_envoye, c.whatsapp_number
       FROM rendez_vous rv
       JOIN contacts c ON c.id = rv.contact_id
       WHERE rv.id = $1`,
      [rdvId]
    )
  );
  const rdv = rows[0];
  if (!rdv || rdv.rappel_envoye) return; // idempotence

  const clientRow = await pool.query(`SELECT whatsapp_business_number FROM clients WHERE id = $1`, [
    rdv.client_id,
  ]);
  const client = await resolveClientByWhatsappNumber(clientRow.rows[0]?.whatsapp_business_number);
  if (!client) return;

  const heure = new Date(rdv.datetime).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
  await sendWhatsappText(
    client,
    rdv.whatsapp_number,
    `Rappel : vous avez rendez-vous demain (${heure}) — ${rdv.motif}. À bientôt chez ${client.nomEntreprise} !`
  );
  await withTenant(client.id, (db) =>
    db.query(`UPDATE rendez_vous SET rappel_envoye = true WHERE id = $1`, [rdvId])
  );
}

relancesWorker.on("failed", (job, err) => console.error(`Job relance ${job?.id} échoué:`, err));
rappelsWorker.on("failed", (job, err) => console.error(`Job rappel ${job?.id} échoué:`, err));

console.log("Workers BullMQ démarrés (relances, rappels-rdv).");
