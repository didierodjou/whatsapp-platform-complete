import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import crypto from "crypto";
import express from "express";
import type { Server } from "http";

/**
 * Tests E2E : parcourent la vraie chaîne
 *   webhook Meta (signature) → orchestrateur → RAG → boucle tool use → base
 * sur une vraie base Postgres, avec les seules dépendances externes
 * (Anthropic, Graph API WhatsApp, Google Calendar, HubSpot, Resend/Slack,
 * Voyage) remplacées par des mocks — aucun appel réseau, aucun coût.
 *
 * Prérequis : `docker compose up -d && npm run migrate && npm run seed`.
 * Si DATABASE_URL n'est pas joignable, toute la suite est ignorée (skip)
 * au lieu d'échouer, pour ne pas bloquer un `npm test` sans infra.
 */

// ------------------------------------------------------------------
// Mocks (hoistés au-dessus des imports par vi.mock)
// ------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  // Vecteur constant : toutes les requêtes et tous les chunks partagent le
  // même embedding, donc la recherche vectorielle retourne bien le chunk du
  // client — ce qu'on veut vérifier ici, c'est le scoping, pas la pertinence.
  // 1024 = dimension de voyage-3 (cf. migrations/006_embedding_dim_1024.sql).
  const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
  return {
    vector,
    anthropicCreate: vi.fn(),
    sendWhatsappText: vi.fn(async () => {}),
    sendWhatsappTemplate: vi.fn(async () => {}),
    embed: vi.fn(async () => vector),
    checkAvailability: vi.fn(async () => ["2026-09-10T18:00:00.000Z"]),
    createCalendarEvent: vi.fn(async () => ({ id: "gcal_evt_e2e" })),
    pushLeadToHubspot: vi.fn(async () => {}),
    notifyEscalation: vi.fn(async () => {}),
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mocks.anthropicCreate };
    constructor(_options?: unknown) {}
  },
}));

vi.mock("../src/rag/embed", () => ({
  embed: mocks.embed,
  embedBatch: async (textes: string[]) => textes.map(() => mocks.vector),
  EMBEDDING_DIMENSIONS: 1024,
}));

// verifyMetaSignature / parseWebhookPayload restent réels (c'est ce qu'on teste)
vi.mock("../src/integrations/whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/integrations/whatsapp")>()),
  sendWhatsappText: mocks.sendWhatsappText,
  sendWhatsappTemplate: mocks.sendWhatsappTemplate,
}));

vi.mock("../src/integrations/calendar", () => ({
  checkAvailability: mocks.checkAvailability,
  createCalendarEvent: mocks.createCalendarEvent,
}));

vi.mock("../src/integrations/hubspot", () => ({ pushLeadToHubspot: mocks.pushLeadToHubspot }));
vi.mock("../src/escalation/notify", () => ({ notifyEscalation: mocks.notifyEscalation }));

import { pool } from "../src/db/pool";
import { handleIncomingMessage } from "../src/orchestrator/handleIncomingMessage";
import { whatsappWebhookRouter } from "../src/webhook/whatsappWebhook";

// ------------------------------------------------------------------
// Infra de test
// ------------------------------------------------------------------
const APP_SECRET = "e2e_app_secret";
const NUM_RESTO = "+33900000001";
const NUM_IMMO = "+33900000002";
const NUM_SUSPENDU = "+33900000003";
const NUM_CONTACT = "+33911111111";
const E2E_NUMBERS = [NUM_RESTO, NUM_IMMO, NUM_SUSPENDU];

const dbReady = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

if (!dbReady) {
  console.warn(
    "[e2e] DATABASE_URL injoignable — suite E2E ignorée. Lance `docker compose up -d && npm run migrate && npm run seed`."
  );
}

const e2e = dbReady ? describe : describe.skip;

/** Réponse Claude scriptée : texte final. */
function reponseTexte(text: string) {
  return { content: [{ type: "text", text }] };
}

/** Réponse Claude scriptée : demande d'exécution d'un tool. */
function reponseTool(name: string, input: Record<string, unknown>, id = `tu_${name}`) {
  return { content: [{ type: "tool_use", id, name, input }] };
}

/** Enchaîne les réponses scriptées dans l'ordre des appels à Claude. */
function scripterClaude(...reponses: unknown[]) {
  mocks.anthropicCreate.mockReset();
  for (const r of reponses) mocks.anthropicCreate.mockResolvedValueOnce(r);
}

/** Arguments du n-ième appel à Claude (system prompt, tools, messages). */
function appelClaude(index = 0) {
  return mocks.anthropicCreate.mock.calls[index][0] as {
    system: string;
    tools: { name: string }[];
    messages: any[];
  };
}

async function attendre(predicat: () => boolean, timeoutMs = 5000) {
  const debut = Date.now();
  while (!predicat()) {
    if (Date.now() - debut > timeoutMs) throw new Error("Timeout : traitement webhook non terminé.");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function creerClient(opts: {
  secteur: string;
  nom: string;
  numero: string;
  statut?: string;
}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO clients (sector_profile_id, nom_entreprise, whatsapp_business_number,
                          whatsapp_phone_number_id, variables_prompt, statut)
     VALUES ((SELECT id FROM sector_profiles WHERE nom_secteur = $1), $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      opts.secteur,
      opts.nom,
      opts.numero,
      `pn_${opts.numero}`,
      { horaires: "Lun-Sam 11h-22h", tarifs: "Menu du jour 3500 FCFA" },
      opts.statut ?? "actif",
    ]
  );
  return rows[0].id;
}

async function nettoyerClientsE2E() {
  await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = ANY($1)`, [E2E_NUMBERS]);
}

// ------------------------------------------------------------------
e2e("E2E — pipeline message entrant → Claude → tools → base", () => {
  let clientResto: string;
  let clientImmo: string;
  let clientSuspendu: string;

  beforeAll(async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    // Cette suite valide l'implémentation Anthropic (SDK simulé) : on épingle
    // le fournisseur pour ne pas dépendre du LLM_PROVIDER du .env local.
    process.env.LLM_PROVIDER = "anthropic";
    await nettoyerClientsE2E();

    clientResto = await creerClient({
      secteur: "restaurant",
      nom: "Chez Amara E2E",
      numero: NUM_RESTO,
    });
    clientImmo = await creerClient({
      secteur: "immobilier",
      nom: "Agence Kouassi E2E",
      numero: NUM_IMMO,
    });
    clientSuspendu = await creerClient({
      secteur: "restaurant",
      nom: "Resto Suspendu E2E",
      numero: NUM_SUSPENDU,
      statut: "suspendu",
    });

    // Base de connaissance scopée au restaurant uniquement
    await pool.query(
      `INSERT INTO knowledge_base_chunks (client_id, contenu, embedding, source)
       VALUES ($1, $2, $3, $4)`,
      [
        clientResto,
        "Le menu du jour est à 3500 FCFA, servi du lundi au samedi de 11h à 15h.",
        JSON.stringify(mocks.vector),
        "e2e_faq",
      ]
    );
  });

  afterAll(async () => {
    await nettoyerClientsE2E();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embed.mockResolvedValue(mocks.vector);
    mocks.checkAvailability.mockResolvedValue(["2026-09-10T18:00:00.000Z"]);
    mocks.createCalendarEvent.mockResolvedValue({ id: "gcal_evt_e2e" });
  });

  it("Service d'embeddings indisponible : le contact reçoit quand même une réponse (RAG dégradé)", async () => {
    mocks.embed.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })
    );
    scripterClaude(reponseTexte("Nous sommes ouverts du lundi au samedi."));

    const contact = "+33911111118";
    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: contact,
      text: "Vous ouvrez quand ?",
    });

    // Claude est appelé malgré la panne, avec un contexte RAG vide et explicite
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(appelClaude().system).toContain("aucune information pertinente trouvée");
    expect(appelClaude().system).toContain("Chez Amara E2E"); // variables client toujours là

    // ...et surtout : le contact obtient une réponse, il n'est pas laissé sans rien
    expect(mocks.sendWhatsappText).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      `SELECT cv.role FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
       WHERE c.whatsapp_number = $1 ORDER BY cv.timestamp`,
      [contact]
    );
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("SAV : la réponse s'appuie sur la base de connaissance du client et la conversation est historisée", async () => {
    scripterClaude(reponseTexte("Le menu du jour est à 3500 FCFA, servi de 11h à 15h."));

    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: NUM_CONTACT,
      text: "Quel est le prix du menu du jour ?",
    });

    // Le contexte RAG du bon client est bien injecté dans le system prompt
    const { system } = appelClaude();
    expect(system).toContain("Chez Amara E2E");
    expect(system).toContain("3500 FCFA");
    expect(system).toContain("Lun-Sam 11h-22h"); // variables_prompt du client

    // La réponse part réellement vers WhatsApp
    expect(mocks.sendWhatsappText).toHaveBeenCalledTimes(1);
    const [, destinataire, texte] = mocks.sendWhatsappText.mock.calls[0] as any[];
    expect(destinataire).toBe(NUM_CONTACT);
    expect(texte).toContain("3500 FCFA");

    // Les deux tours sont journalisés
    // Scopé au contact de ce test : d'autres tests du fichier écrivent aussi
    // des conversations pour ce client.
    const { rows } = await pool.query(
      `SELECT cv.role, cv.contenu FROM conversations cv
       JOIN contacts c ON c.id = cv.contact_id
       WHERE c.client_id = $1 AND c.whatsapp_number = $2 ORDER BY cv.timestamp`,
      [clientResto, NUM_CONTACT]
    );
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[0].contenu).toContain("menu du jour");
  });

  it("Réservation : check_calendar_availability puis book_appointment → RDV enregistré avec l'ID Google", async () => {
    scripterClaude(
      reponseTool("check_calendar_availability", {
        date_debut: "2026-09-10T09:00:00.000Z",
        date_fin: "2026-09-10T21:00:00.000Z",
      }),
      reponseTool("book_appointment", {
        datetime: "2026-09-10T18:00:00.000Z",
        motif: "Table pour 4",
        champs_specifiques: { couverts: 4, allergies: "aucune" },
      }),
      reponseTexte("C'est noté : table pour 4 le 10 septembre à 18h. À très vite !")
    );

    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: "+33911111112",
      text: "Une table pour 4 ce jeudi soir ?",
    });

    expect(mocks.checkAvailability).toHaveBeenCalledTimes(1);
    expect(mocks.createCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: clientResto }),
      "2026-09-10T18:00:00.000Z",
      "Table pour 4"
    );

    const { rows } = await pool.query(
      `SELECT motif, google_event_id, champs_specifiques, statut FROM rendez_vous WHERE client_id = $1`,
      [clientResto]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      motif: "Table pour 4",
      google_event_id: "gcal_evt_e2e",
      statut: "confirme",
    });
    expect(rows[0].champs_specifiques).toEqual({ couverts: 4, allergies: "aucune" });
    expect(mocks.sendWhatsappText).toHaveBeenCalledTimes(1);
  });

  it("R2 : calendrier indisponible → Claude reçoit un message d'erreur exploitable, le contact reçoit une réponse", async () => {
    mocks.checkAvailability.mockRejectedValueOnce(
      new Error("Google Calendar OAuth expired for client ...")
    );
    scripterClaude(
      reponseTool("check_calendar_availability", {
        date_debut: "2026-09-10T09:00:00.000Z",
        date_fin: "2026-09-10T21:00:00.000Z",
      }),
      reponseTexte("Notre agenda est momentanément indisponible, je transmets votre demande.")
    );

    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: "+33911111113",
      text: "Vous avez de la place demain ?",
    });

    // Le tool_result renvoyé à Claude porte l'erreur métier, pas une exception
    const toolResult = appelClaude(1).messages.at(-1).content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toContain("Calendrier temporairement indisponible");
    expect(mocks.sendWhatsappText).toHaveBeenCalledTimes(1);
  });

  it("Qualification immobilier : create_lead → score en base, push HubSpot et alerte lead chaud", async () => {
    scripterClaude(
      reponseTool("create_lead", {
        nom: "M. Diallo",
        besoin: "3 pièces à Cocody",
        budget: "400 000 €",
        score: 85,
        contact_pref: "whatsapp",
      }),
      reponseTexte("Merci, un conseiller vous rappelle très vite.")
    );

    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_IMMO,
      fromWhatsappNumber: NUM_CONTACT,
      text: "Je cherche un 3 pièces à Cocody, budget 400k, sous 2 mois.",
    });

    const { rows } = await pool.query(
      `SELECT score_lead FROM contacts WHERE client_id = $1 AND whatsapp_number = $2`,
      [clientImmo, NUM_CONTACT]
    );
    expect(rows[0].score_lead).toBe(85);

    expect(mocks.pushLeadToHubspot).toHaveBeenCalledWith(
      expect.objectContaining({ id: clientImmo }),
      expect.objectContaining({ nom: "M. Diallo", score: 85, whatsappNumber: NUM_CONTACT })
    );
    // score >= 70 → notification lead chaud
    expect(mocks.notifyEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ id: clientImmo }),
      expect.objectContaining({ resume: expect.stringContaining("Lead chaud") })
    );
  });

  it("Escalade : escalate_to_human ouvre une escalade, gèle le contact, et le message suivant n'est plus automatisé", async () => {
    const contact = "+33911111114";
    scripterClaude(
      reponseTool("escalate_to_human", {
        resume: "Litige sur une commande livrée endommagée",
        urgence: "haute",
      }),
      reponseTexte("Je transmets immédiatement à un responsable.")
    );

    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: contact,
      text: "Ma commande est arrivée cassée, c'est inadmissible.",
    });

    const { rows: escalades } = await pool.query(
      `SELECT resume, urgence, statut FROM escalades WHERE client_id = $1`,
      [clientResto]
    );
    expect(escalades).toHaveLength(1);
    expect(escalades[0]).toMatchObject({ urgence: "haute", statut: "ouverte" });

    const { rows: contacts } = await pool.query(
      `SELECT statut FROM contacts WHERE client_id = $1 AND whatsapp_number = $2`,
      [clientResto, contact]
    );
    expect(contacts[0].statut).toBe("escalade");

    // Message suivant : aucun appel à Claude, aucun envoi automatique
    vi.clearAllMocks();
    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: contact,
      text: "Alors, vous faites quoi ?",
    });
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.sendWhatsappText).not.toHaveBeenCalled();
  });

  it("Client suspendu : le message est ignoré (ni Claude, ni envoi, ni contact créé)", async () => {
    scripterClaude(reponseTexte("ne devrait jamais être appelé"));

    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_SUSPENDU,
      fromWhatsappNumber: NUM_CONTACT,
      text: "Bonjour",
    });

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.sendWhatsappText).not.toHaveBeenCalled();
    const { rows } = await pool.query(`SELECT 1 FROM contacts WHERE client_id = $1`, [
      clientSuspendu,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("Le numéro Business est résolu quel que soit son formatage (Meta varie entre '+1 555-678-3446' et '15556783446')", async () => {
    const numeroFormate = "+33 900-000-004";
    const clientFormate = await creerClient({
      secteur: "restaurant",
      nom: "Resto Format E2E",
      numero: numeroFormate,
    });
    E2E_NUMBERS.push(numeroFormate);

    scripterClaude(reponseTexte("Bonjour !"));
    await handleIncomingMessage({
      toWhatsappBusinessNumber: "33900000004", // forme envoyée par le webhook
      fromWhatsappNumber: "+33911111117",
      text: "Bonjour",
    });

    expect(mocks.sendWhatsappText).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE client_id = $1`, [
      clientFormate,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("Numéro Business inconnu : aucun traitement, aucune fuite vers un autre client", async () => {
    scripterClaude(reponseTexte("ne devrait jamais être appelé"));

    await handleIncomingMessage({
      toWhatsappBusinessNumber: "+33999999999",
      fromWhatsappNumber: NUM_CONTACT,
      text: "Bonjour",
    });

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.sendWhatsappText).not.toHaveBeenCalled();
  });

  it("R1 : erreur 429 côté Anthropic → message de repli envoyé et historisé", async () => {
    mocks.anthropicCreate.mockReset();
    mocks.anthropicCreate.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));

    const contact = "+33911111115";
    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: contact,
      text: "Bonjour",
    });

    const [, , texte] = mocks.sendWhatsappText.mock.calls[0] as any[];
    expect(texte).toContain("temporairement surchargé");

    const { rows } = await pool.query(
      `SELECT cv.contenu FROM conversations cv
       JOIN contacts c ON c.id = cv.contact_id
       WHERE c.whatsapp_number = $1 AND cv.role = 'assistant'`,
      [contact]
    );
    expect(rows[0].contenu).toContain("temporairement surchargé");
  });

  it("Les tools exposés à Claude suivent les workflows actifs du secteur", async () => {
    scripterClaude(reponseTexte("ok"));
    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: "+33911111116",
      text: "Bonjour",
    });
    const toolsResto = appelClaude().tools.map((t) => t.name);
    expect(toolsResto).toContain("book_appointment"); // rdv: true
    expect(toolsResto).toContain("escalate_to_human"); // toujours disponible
    expect(toolsResto).not.toContain("create_lead"); // qualification: false

    scripterClaude(reponseTexte("ok"));
    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_IMMO,
      fromWhatsappNumber: "+33911111116",
      text: "Bonjour",
    });
    const toolsImmo = appelClaude().tools.map((t) => t.name);
    expect(toolsImmo).toContain("create_lead"); // qualification: true
  });

  it("Isolation multi-tenant : un même numéro de contact chez deux clients garde deux historiques séparés", async () => {
    const { rows } = await pool.query(
      `SELECT c.client_id, count(cv.id)::int AS messages
       FROM contacts c LEFT JOIN conversations cv ON cv.contact_id = c.id
       WHERE c.whatsapp_number = $1 AND c.client_id = ANY($2)
       GROUP BY c.client_id`,
      [NUM_CONTACT, [clientResto, clientImmo]]
    );
    expect(rows).toHaveLength(2); // deux contacts distincts, un par client

    scripterClaude(reponseTexte("Réponse restaurant"));
    await handleIncomingMessage({
      toWhatsappBusinessNumber: NUM_RESTO,
      fromWhatsappNumber: NUM_CONTACT,
      text: "Et vos horaires du dimanche ?",
    });

    // L'historique envoyé à Claude ne contient que les échanges du restaurant
    const historique = appelClaude()
      .messages.map((m: any) => (typeof m.content === "string" ? m.content : ""))
      .join(" ");
    expect(historique).not.toContain("Cocody");
    // ...et le contexte RAG de l'immobilier n'a pas fuité dans celui du restaurant
    expect(appelClaude().system).toContain("Chez Amara E2E");
  });
});

// ------------------------------------------------------------------
e2e("E2E — webhook HTTP Meta", () => {
  let server: Server;
  let baseUrl: string;
  let clientId: string;

  beforeAll(async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = "e2e_verify_token";
    process.env.LLM_PROVIDER = "anthropic";
    await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = $1`, [NUM_RESTO]);
    clientId = await creerClient({
      secteur: "restaurant",
      nom: "Chez Amara Webhook E2E",
      numero: NUM_RESTO,
    });

    // Même montage que src/server.ts : rawBody conservé pour la signature
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
    app.use(whatsappWebhookRouter);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.query(`DELETE FROM clients WHERE whatsapp_business_number = $1`, [NUM_RESTO]);
    await pool.end();
  });

  beforeEach(() => vi.clearAllMocks());

  function payload(texte: string) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: `pn_${NUM_RESTO}`, display_phone_number: NUM_RESTO },
                messages: [{ from: NUM_CONTACT, type: "text", text: { body: texte } }],
              },
            },
          ],
        },
      ],
    };
  }

  async function postWebhook(body: unknown, secret: string | null) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) {
      headers["x-hub-signature-256"] =
        "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex");
    }
    return fetch(`${baseUrl}/webhook`, { method: "POST", headers, body: raw });
  }

  it("GET /webhook renvoie le hub.challenge quand le verify token est correct", async () => {
    const ok = await fetch(
      `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=e2e_verify_token&hub.challenge=42`
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");

    const ko = await fetch(
      `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=mauvais&hub.challenge=42`
    );
    expect(ko.status).toBe(403);
  });

  it("POST /webhook signé : 200 puis traitement complet jusqu'à l'envoi de la réponse", async () => {
    scripterClaude(reponseTexte("Bonjour ! Que puis-je pour vous ?"));

    const res = await postWebhook(payload("Bonjour"), APP_SECRET);
    expect(res.status).toBe(200); // Meta est acquitté avant traitement (règle des 20 s)

    await attendre(() => mocks.sendWhatsappText.mock.calls.length > 0);
    const [, destinataire, texte] = mocks.sendWhatsappText.mock.calls[0] as any[];
    expect(destinataire).toBe(NUM_CONTACT);
    expect(texte).toContain("Bonjour");

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM conversations cv
       JOIN contacts c ON c.id = cv.contact_id WHERE c.client_id = $1`,
      [clientId]
    );
    expect(rows[0].n).toBe(2);
  });

  it("POST /webhook avec signature invalide : 401 et aucun traitement", async () => {
    scripterClaude(reponseTexte("ne devrait jamais être appelé"));

    const res = await postWebhook(payload("Bonjour"), "mauvais_secret");
    expect(res.status).toBe(401);

    const sansSignature = await postWebhook(payload("Bonjour"), null);
    expect(sansSignature.status).toBe(401);

    await new Promise((r) => setTimeout(r, 100));
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.sendWhatsappText).not.toHaveBeenCalled();
  });
});
