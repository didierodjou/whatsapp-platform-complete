import { Router } from "express";
import { z } from "zod";
import { pool, withTenant, withAdmin } from "../db/pool";
import { requireAdminKey } from "../middleware/adminAuth";
import { asyncRoute } from "../utils/asyncRoute";
import { embedBatch } from "../rag/embed";
import { sendWhatsappTemplate } from "../integrations/whatsapp";
import { resolveClientByWhatsappNumber } from "../orchestrator/resolveClient";
import { relancesQueue, rappelsQueue } from "../scheduler/queues";

export const adminRouter = Router();
adminRouter.use(requireAdminKey);

// R6: Worker Health Check
adminRouter.get("/worker-health", asyncRoute(async (_req, res) => {
  try {
    const relancesCount = await relancesQueue.getJobCounts();
    const rappelsCount = await rappelsQueue.getJobCounts();
    
    const total_waiting = relancesCount.waiting + rappelsCount.waiting;
    const is_degraded = total_waiting > 100; // Alert if > 100 jobs stuck
    
    res.json({
      status: is_degraded ? "⚠️  degraded" : "✅ ok",
      queues: {
        relances: relancesCount,
        rappels_rdv: rappelsCount,
      },
      total_jobs_waiting: total_waiting,
      recommendation: is_degraded 
        ? "Check if worker process is running: npm run worker" 
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}));

// -------------------------------------------------------------
// GET /admin/sector-profiles — liste des profils sectoriels disponibles
// (alimente le sélecteur de secteur dans l'interface d'onboarding)
// -------------------------------------------------------------
adminRouter.get("/sector-profiles", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nom_secteur, workflows_actifs, champs_rdv, ton_par_defaut
     FROM sector_profiles ORDER BY nom_secteur`
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      nomSecteur: r.nom_secteur,
      workflowsActifs: r.workflows_actifs,
      champsRdv: r.champs_rdv,
      tonParDefaut: r.ton_par_defaut,
    }))
  );
}));

// -------------------------------------------------------------
// GET /admin/clients — liste des clients onboardés
// (alimente le dashboard de l'interface d'onboarding)
// -------------------------------------------------------------
adminRouter.get("/clients", asyncRoute(async (req, res) => {
  const search = (req.query.q as string) ?? "";
  const { rows } = await pool.query(
    `SELECT c.id, c.nom_entreprise, c.whatsapp_business_number, c.statut, c.created_at,
            sp.nom_secteur
     FROM clients c
     JOIN sector_profiles sp ON sp.id = c.sector_profile_id
     WHERE c.nom_entreprise ILIKE $1
     ORDER BY c.created_at DESC`,
    [`%${search}%`]
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      nomEntreprise: r.nom_entreprise,
      numero: r.whatsapp_business_number,
      statut: r.statut,
      secteur: r.nom_secteur,
      createdAt: r.created_at,
    }))
  );
}));

// -------------------------------------------------------------
// GET /admin/clients/:id — détail d'un client (pour préremplir une duplication)
// -------------------------------------------------------------
adminRouter.get("/clients/:id", asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nom_entreprise, c.whatsapp_business_number, c.whatsapp_phone_number_id,
            c.variables_prompt, c.statut, c.hubspot_account_id, c.google_calendar_id,
            sp.nom_secteur
     FROM clients c
     JOIN sector_profiles sp ON sp.id = c.sector_profile_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Client introuvable." });
  const r = rows[0];
  res.json({
    id: r.id,
    nomEntreprise: r.nom_entreprise,
    numero: r.whatsapp_business_number,
    whatsappPhoneNumberId: r.whatsapp_phone_number_id,
    variablesPrompt: r.variables_prompt,
    statut: r.statut,
    secteur: r.nom_secteur,
    hubspotConnecte: !!r.hubspot_account_id,
    calendarConnecte: !!r.google_calendar_id,
  });
}));

// -------------------------------------------------------------
// POST /admin/clients — onboarding d'un nouveau client
// -------------------------------------------------------------
const createClientSchema = z.object({
  secteur: z.enum(["restaurant", "boutique", "immobilier", "sport", "dentaire"]),
  nom_entreprise: z.string().min(2),
  whatsapp_business_number: z.string().min(6),
  whatsapp_phone_number_id: z.string().optional(),
  variables_prompt: z.record(z.string()).default({}),
});

adminRouter.post("/clients", asyncRoute(async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { secteur, nom_entreprise, whatsapp_business_number, whatsapp_phone_number_id, variables_prompt } =
    parsed.data;

  const sectorRes = await pool.query(`SELECT id FROM sector_profiles WHERE nom_secteur = $1`, [
    secteur,
  ]);
  if (sectorRes.rows.length === 0) {
    return res.status(400).json({ error: `Secteur inconnu: ${secteur}. Crée-le d'abord dans sector_profiles.` });
  }

  const insertRes = await pool.query(
    `INSERT INTO clients (sector_profile_id, nom_entreprise, whatsapp_business_number, whatsapp_phone_number_id, variables_prompt)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [sectorRes.rows[0].id, nom_entreprise, whatsapp_business_number, whatsapp_phone_number_id ?? null, variables_prompt]
  );
  const clientId = insertRes.rows[0].id;

  await seedMinimalKnowledgeBase(clientId, secteur, nom_entreprise);

  return res.status(201).json({
    client_id: clientId,
    checklist_restante: [
      "Connecter le compte HubSpot (renseigner hubspot_account_id)",
      `Connecter Google Calendar : ${process.env.BASE_URL ?? ""}/oauth/google/start?client_id=${clientId}`,
      "Faire valider les templates WhatsApp (rappel RDV, relance, newsletter) par Meta",
      "Compléter la base de connaissance au-delà de la FAQ générique injectée",
      "Renseigner whatsapp_phone_number_id si non fourni à la création",
    ],
    lien_oauth_calendar: `${process.env.BASE_URL ?? ""}/oauth/google/start?client_id=${clientId}`,
  });
}));

// PATCH /admin/clients/:id — modification partielle de la configuration client
const updateClientSchema = z.object({
  secteur: z.enum(["restaurant", "boutique", "immobilier", "sport", "dentaire"]).optional(),
  nom_entreprise: z.string().min(2).optional(),
  whatsapp_business_number: z.string().min(6).optional(),
  whatsapp_phone_number_id: z.string().nullable().optional(),
  variables_prompt: z.record(z.string()).optional(),
  statut: z.enum(["actif", "onboarding", "suspendu"]).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "Au moins un paramètre doit être modifié.",
});

adminRouter.patch("/clients/:id", asyncRoute(async (req, res) => {
  const parsed = updateClientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const values = parsed.data;
  const sectorRes = values.secteur
    ? await pool.query(`SELECT id FROM sector_profiles WHERE nom_secteur = $1`, [values.secteur])
    : null;
  if (sectorRes && sectorRes.rows.length === 0) {
    return res.status(400).json({ error: `Secteur inconnu: ${values.secteur}.` });
  }

  const result = await pool.query(
    `UPDATE clients
     SET sector_profile_id = COALESCE($1, sector_profile_id),
         nom_entreprise = COALESCE($2, nom_entreprise),
         whatsapp_business_number = COALESCE($3, whatsapp_business_number),
         whatsapp_phone_number_id = COALESCE($4, whatsapp_phone_number_id),
         variables_prompt = COALESCE($5, variables_prompt),
         statut = COALESCE($6, statut)
     WHERE id = $7
     RETURNING id`,
    [
      sectorRes?.rows[0]?.id ?? null,
      values.nom_entreprise ?? null,
      values.whatsapp_business_number ?? null,
      values.whatsapp_phone_number_id === undefined ? null : values.whatsapp_phone_number_id,
      values.variables_prompt ?? null,
      values.statut ?? null,
      req.params.id,
    ]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Client introuvable." });
  res.json({ client_id: result.rows[0].id, statut: "modifie" });
}));

// -------------------------------------------------------------
// DELETE /admin/clients/:id — suppression définitive d'un client
//
// Supprime en cascade contacts, conversations, rendez-vous, relances,
// base de connaissance et escalades (ON DELETE CASCADE, migration 001).
// Irréversible : préférer l'archivage (PATCH statut = 'suspendu'), qui
// coupe l'automatisation en conservant l'historique.
// -------------------------------------------------------------
adminRouter.delete("/clients/:id", asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT nom_entreprise, whatsapp_business_number FROM clients WHERE id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "Client introuvable." });

  const supprime = await withAdmin(async (db) => {
    const compte = async (sql: string) => Number((await db.query(sql, [req.params.id])).rows[0].n);
    return {
      contacts: await compte(`SELECT count(*)::int AS n FROM contacts WHERE client_id = $1`),
      conversations: await compte(
        `SELECT count(*)::int AS n FROM conversations cv
         JOIN contacts c ON c.id = cv.contact_id WHERE c.client_id = $1`
      ),
      rendez_vous: await compte(`SELECT count(*)::int AS n FROM rendez_vous WHERE client_id = $1`),
      relances: await compte(
        `SELECT count(*)::int AS n FROM relances_programmees WHERE client_id = $1`
      ),
      chunks: await compte(
        `SELECT count(*)::int AS n FROM knowledge_base_chunks WHERE client_id = $1`
      ),
      escalades: await compte(`SELECT count(*)::int AS n FROM escalades WHERE client_id = $1`),
    };
  });

  await pool.query(`DELETE FROM clients WHERE id = $1`, [req.params.id]);

  console.warn(
    `Client supprimé : ${rows[0].nom_entreprise} (${rows[0].whatsapp_business_number}) — ` +
      `${supprime.contacts} contacts, ${supprime.conversations} messages effacés.`
  );
  res.json({ statut: "supprime", nom_entreprise: rows[0].nom_entreprise, donnees_supprimees: supprime });
}));

async function seedMinimalKnowledgeBase(clientId: string, secteur: string, nomEntreprise: string) {
  const faqGenerique: Record<string, string[]> = {
    restaurant: [
      `${nomEntreprise} accepte les réservations par WhatsApp. Merci de préciser le nombre de couverts et la date souhaitée.`,
      `Pensez à signaler toute allergie ou restriction alimentaire lors de votre réservation.`,
    ],
    boutique: [
      `${nomEntreprise} traite les retours sous 14 jours après réception, produit non porté avec étiquette.`,
      `Les délais de livraison standards sont communiqués après confirmation de commande.`,
    ],
    immobilier: [
      `${nomEntreprise} accompagne les recherches de bien à l'achat comme à la location.`,
      `Une visite peut être planifiée directement via WhatsApp après qualification du besoin.`,
    ],
    sport: [
      `${nomEntreprise} propose une séance d'essai gratuite pour tout nouveau prospect.`,
      `Les abonnements sont sans engagement de durée minimum sauf mention contraire.`,
    ],
    dentaire: [
      `${nomEntreprise} traite les urgences dentaires en priorité — merci de le signaler dès le premier message.`,
      `Un rappel de contrôle annuel est envoyé automatiquement aux patients suivis.`,
    ],
  };

  const chunks = faqGenerique[secteur] ?? [];
  if (chunks.length === 0) return;

  try {
    const embeddings = await embedBatch(chunks);
    for (let i = 0; i < chunks.length; i++) {
      await withTenant(clientId, (db) =>
        db.query(
          `INSERT INTO knowledge_base_chunks (client_id, contenu, embedding, source) VALUES ($1, $2, $3, $4)`,
          [clientId, chunks[i], JSON.stringify(embeddings[i]), "faq_generique_secteur"]
        )
      );
    }
  } catch (err) {
    console.warn("Embeddings non générés (VOYAGE_API_KEY manquant ?) — FAQ générique ignorée:", err);
  }
}

// -------------------------------------------------------------
// POST /admin/knowledge-base — ingestion / mise à jour sans redéploiement
// -------------------------------------------------------------
const ingestSchema = z.object({
  client_id: z.string().uuid(),
  chunks: z.array(z.object({ contenu: z.string().min(1), source: z.string().optional() })),
});

adminRouter.post("/knowledge-base", asyncRoute(async (req, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { client_id, chunks } = parsed.data;
  const embeddings = await embedBatch(chunks.map((c) => c.contenu));

  for (let i = 0; i < chunks.length; i++) {
    await withTenant(client_id, (db) =>
      db.query(
        `INSERT INTO knowledge_base_chunks (client_id, contenu, embedding, source) VALUES ($1, $2, $3, $4)`,
        [client_id, chunks[i].contenu, JSON.stringify(embeddings[i]), chunks[i].source ?? "ingestion_manuelle"]
      )
    );
  }
  res.status(201).json({ inserted: chunks.length });
}));

// -------------------------------------------------------------
// POST /admin/broadcast — newsletter / diffusion commerciale
// -------------------------------------------------------------
const broadcastSchema = z.object({
  client_id: z.string().uuid(),
  template_name: z.string(),
  contact_ids: z.array(z.string().uuid()).optional(), // si omis, tous les opt-in
});

adminRouter.post("/broadcast", asyncRoute(async (req, res) => {
  const parsed = broadcastSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { client_id, template_name, contact_ids } = parsed.data;

  const client = await pool.query(
    `SELECT whatsapp_business_number FROM clients WHERE id = $1`,
    [client_id]
  );
  if (client.rows.length === 0) return res.status(404).json({ error: "Client introuvable." });
  const resolved = await resolveClientByWhatsappNumber(client.rows[0].whatsapp_business_number);
  if (!resolved) return res.status(404).json({ error: "Résolution client échouée." });

  const { rows: contacts } = await withTenant(client_id, (db) =>
    db.query(
      `SELECT id, whatsapp_number FROM contacts
       WHERE client_id = $1 AND opt_in_marketing = true
       ${contact_ids?.length ? "AND id = ANY($2)" : ""}`,
      contact_ids?.length ? [client_id, contact_ids] : [client_id]
    )
  );

  let sent = 0;
  for (const contact of contacts) {
    await sendWhatsappTemplate(resolved, contact.whatsapp_number, template_name);
    sent++;
  }
  res.json({ envoyes: sent });
}));

// -------------------------------------------------------------
// DELETE /admin/contacts/:id — conformité RGPD
// -------------------------------------------------------------
adminRouter.delete("/contacts/:id", asyncRoute(async (req, res) => {
  // withAdmin : lookup cross-tenant (on ne connaît pas encore le client
  // propriétaire) — sans lui, la RLS forcée de 004 renverrait 0 ligne.
  const { rows } = await withAdmin((db) =>
    db.query(`SELECT client_id FROM contacts WHERE id = $1`, [req.params.id])
  );
  const clientId = rows[0]?.client_id;
  if (!clientId) return res.status(404).json({ error: "Contact introuvable." });
  await withTenant(clientId, (db) =>
    db.query(`DELETE FROM contacts WHERE id = $1`, [req.params.id])
  );
  // ON DELETE CASCADE nettoie conversations, rendez_vous, relances_programmees, escalades
  res.json({ statut: "supprime" });
}));
