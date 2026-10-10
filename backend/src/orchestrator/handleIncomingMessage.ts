import { withTenant } from "../db/pool";
import { resolveClientByWhatsappNumber, buildSystemPrompt } from "./resolveClient";
import { retrieveRelevantChunks, formatChunksForPrompt } from "../rag/retrieve";
import { converseWithClaude, HistoryMessage } from "../llm/converse";
import { sendWhatsappText } from "../integrations/whatsapp";

const HISTORY_WINDOW = 10;

/**
 * Point d'entrée unique pour un message WhatsApp entrant.
 * Pipeline : résolution client -> upsert contact -> historique
 * -> RAG -> Claude (+ tools) -> envoi de la réponse -> log.
 */
export async function handleIncomingMessage(params: {
  toWhatsappBusinessNumber: string; // numéro Meta qui a reçu le message (identifie le client)
  fromWhatsappNumber: string; // numéro du contact
  text: string;
}) {
  const client = await resolveClientByWhatsappNumber(params.toWhatsappBusinessNumber);
  if (!client) {
    console.error(`Aucun client trouvé pour le numéro WhatsApp ${params.toWhatsappBusinessNumber}`);
    return;
  }
  if (client.statut !== "actif" && client.statut !== "onboarding") {
    return; // client suspendu : on n'automatise rien
  }

  const contact = await upsertContact(client.id, params.fromWhatsappNumber);

  // Conversation escaladée : on suspend les réponses automatiques
  if (contact.statut === "escalade") return;

  await logMessage(client.id, contact.id, "user", params.text);

  const history = await loadHistory(client.id, contact.id);
  const systemPrompt = buildSystemPrompt(client);

  // Dégradation gracieuse : le RAG dépend d'un service d'embeddings externe.
  // S'il est indisponible (timeout réseau, quota), on répond quand même — avec
  // les seules variables du client — plutôt que de laisser le contact sans
  // aucune réponse. Le prompt interdit déjà d'inventer hors contexte fourni.
  let chunks: Awaited<ReturnType<typeof retrieveRelevantChunks>> = [];
  try {
    chunks = await retrieveRelevantChunks(client.id, params.text);
  } catch (err) {
    console.error(
      `RAG indisponible pour le client ${client.id} — réponse générée sans base de connaissance:`,
      err
    );
  }

  const reply = await converseWithClaude({
    systemPrompt,
    ragContext: formatChunksForPrompt(chunks),
    history,
    userMessage: params.text,
    client,
    contactId: contact.id,
    contactWhatsappNumber: params.fromWhatsappNumber,
  });

  await logMessage(client.id, contact.id, "assistant", reply);
  await sendWhatsappText(client, params.fromWhatsappNumber, reply);
}

async function upsertContact(clientId: string, whatsappNumber: string) {
  const { rows } = await withTenant(clientId, (db) =>
    db.query(
      `INSERT INTO contacts (client_id, whatsapp_number)
       VALUES ($1, $2)
       ON CONFLICT (client_id, whatsapp_number) DO UPDATE SET whatsapp_number = EXCLUDED.whatsapp_number
       RETURNING id, statut`,
      [clientId, whatsappNumber]
    )
  );
  return rows[0] as { id: string; statut: string };
}

async function logMessage(
  clientId: string,
  contactId: string,
  role: "user" | "assistant",
  contenu: string
) {
  await withTenant(clientId, (db) =>
    db.query(
      `INSERT INTO conversations (contact_id, role, contenu) VALUES ($1, $2, $3)`,
      [contactId, role, contenu]
    )
  );
}

async function loadHistory(clientId: string, contactId: string): Promise<HistoryMessage[]> {
  const { rows } = await withTenant(clientId, (db) =>
    db.query(
      `SELECT role, contenu FROM conversations
       WHERE contact_id = $1 AND role IN ('user', 'assistant')
       ORDER BY timestamp DESC
       LIMIT $2`,
      [contactId, HISTORY_WINDOW]
    )
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.contenu }));
}
