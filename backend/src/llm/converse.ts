import Anthropic from "@anthropic-ai/sdk";
import { TOOLS } from "./tools";
import { executeTool } from "./executeTool";
import type { ResolvedClient } from "../orchestrator/resolveClient";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 4;

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Envoie le message au modèle avec le system prompt résolu (core + secteur
 * + variables client + contexte RAG) et exécute la boucle de tool use
 * jusqu'à obtenir une réponse texte finale.
 */
export interface ConverseParams {
  systemPrompt: string;
  ragContext: string;
  history: HistoryMessage[];
  userMessage: string;
  client: ResolvedClient;
  contactId: string;
  contactWhatsappNumber: string;
}

/**
 * Point d'entrée unique de la génération de réponse. Le fournisseur est
 * choisi par LLM_PROVIDER (`anthropic` par défaut, `gemini` pour le palier
 * gratuit de Google AI Studio) : les deux implémentations partagent la même
 * signature, les mêmes tools et les mêmes messages de repli, ce qui permet de
 * basculer sans toucher au reste du système.
 */
export async function converseWithClaude(params: ConverseParams): Promise<string> {
  // Lu à chaque appel (et non au chargement du module) : le fournisseur reste
  // configurable par environnement sans dépendre de l'ordre des imports.
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  if (provider === "gemini") {
    const { converseWithGemini } = await import("./gemini");
    return converseWithGemini(params);
  }
  return converseWithAnthropic(params);
}

async function converseWithAnthropic(params: ConverseParams): Promise<string> {
  const fullSystemPrompt = `${params.systemPrompt}

--- Base de connaissance pertinente pour ce message ---
${params.ragContext}
--- Fin de la base de connaissance ---

Réponds toujours en français, de façon concise (WhatsApp), sans jamais inventer d'information absente de la base de connaissance ou du contexte.`;

  const messages: Anthropic.MessageParam[] = [
    ...params.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: params.userMessage },
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: fullSystemPrompt,
        tools: filterToolsByWorkflow(params.client),
        messages,
      });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
        return textBlock?.text ?? "Désolé, je n'ai pas pu formuler de réponse.";
      }

      // Exécute chaque tool demandé et renvoie les résultats à Claude
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const result = await executeTool(block.name, block.input as Record<string, any>, {
          client: params.client,
          contactId: params.contactId,
          contactWhatsappNumber: params.contactWhatsappNumber,
        });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
    }

    return "Je transmets votre demande à un membre de l'équipe, merci de patienter.";
  } catch (err: any) {
    // Une seule ligne actionnable plutôt que l'objet d'erreur complet du SDK
    // (40 lignes d'en-têtes HTTP qui noyaient la cause réelle en console).
    console.error(`Claude indisponible — ${expliquerErreurClaude(err)}`);

    // R1 : message de repli adapté au type de panne, pour que le contact
    // reçoive toujours quelque chose plutôt qu'un silence.
    if (err.status === 429 || err.code === "rate_limit_error") {
      return "Je suis temporairement surchargé. Pouvez-vous réessayer dans quelques instants ?";
    }
    if (err.name === "APIConnectionTimeoutError" || err.name === "Timeout") {
      return "Je rencontre une latence temporaire. Un moment svp...";
    }
    return "Désolé, je n'ai pas pu traiter votre demande. Pouvez-vous reformuler ou contactez l'équipe?";
  }
}

/** Traduit une erreur du SDK Anthropic en une phrase exploitable côté exploitation. */
export function expliquerErreurClaude(err: any): string {
  const message: string = err?.error?.error?.message ?? err?.message ?? String(err);

  if (/credit balance is too low/i.test(message)) {
    return "solde de crédits Anthropic épuisé. Recharge sur console.anthropic.com > Plans & Billing. " +
      "Le contact a reçu le message de repli.";
  }
  if (err?.status === 401 || /authentication/i.test(message)) {
    return "ANTHROPIC_API_KEY invalide ou révoquée — vérifie la clé dans .env, puis redémarre le serveur.";
  }
  if (err?.status === 429) {
    return "limite de débit Anthropic atteinte : le contact est invité à réessayer.";
  }
  if (err?.status === 404 && /model/i.test(message)) {
    return `modèle inconnu (ANTHROPIC_MODEL = ${process.env.ANTHROPIC_MODEL ?? MODEL}) — corrige l'identifiant dans .env.`;
  }
  if (err?.name === "APIConnectionTimeoutError" || err?.name === "APIConnectionError") {
    return "connexion à l'API Anthropic impossible (réseau ou pare-feu).";
  }
  return `${err?.status ? `HTTP ${err.status} — ` : ""}${message}`;
}

/** N'expose à Claude que les tools pertinents pour les workflows actifs du secteur. */
function filterToolsByWorkflow(client: ResolvedClient): Anthropic.Tool[] {
  const w = client.sectorProfile.workflowsActifs;
  return TOOLS.filter((t) => {
    if (t.name === "check_calendar_availability" || t.name === "book_appointment") return w.rdv;
    if (t.name === "create_lead") return w.qualification;
    if (t.name === "unsubscribe_contact") return w.newsletter || w.relance;
    return true; // escalate_to_human toujours disponible
  });
}
