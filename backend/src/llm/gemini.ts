import { TOOLS } from "./tools";
import { executeTool } from "./executeTool";
import type { ResolvedClient } from "../orchestrator/resolveClient";
import type { HistoryMessage } from "./converse";

/**
 * Implémentation Gemini de la boucle conversationnelle, alternative à Claude
 * (palier gratuit de l'API Google AI Studio). Appelée depuis converse.ts quand
 * LLM_PROVIDER=gemini.
 *
 * Volontairement en REST plutôt qu'avec le SDK : le reste du projet appelle
 * déjà Voyage et Meta de cette façon, et cela évite une dépendance de plus.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 45_000);
const MAX_TOOL_ROUNDS = 4;
const TENTATIVES = 3;
// Le quota gratuit se réinitialise à la minute : une attente courte suffit.
const ATTENTE_429_MS = Number(process.env.GEMINI_RETRY_MS ?? 4000);

/**
 * Les modèles Gemini 3.x raisonnent avant de répondre, et ces tokens de
 * réflexion sont décomptés de maxOutputTokens. Vérifié en conditions réelles :
 * avec 1024 tokens, la réflexion consommait tout le budget et l'API renvoyait
 * un contenu VIDE avec finishReason MAX_TOKENS — le contact n'aurait rien reçu.
 * D'où un plafond large, et un niveau de réflexion bas (une réponse WhatsApp
 * courte n'a pas besoin de plus). `thinkingBudget: 0` n'est pas accepté sur ce
 * modèle : il renvoie une 400.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 2048);
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL ?? "low";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, any> };
  functionResponse?: { name: string; response: Record<string, any> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Convertit un schéma JSON (format Anthropic) vers le sous-ensemble OpenAPI
 * attendu par Gemini : types en majuscules et mots-clés non supportés retirés,
 * sinon l'API rejette la requête avec une 400 peu explicite.
 */
function convertirSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  const TYPES: Record<string, string> = {
    object: "OBJECT",
    string: "STRING",
    integer: "INTEGER",
    number: "NUMBER",
    boolean: "BOOLEAN",
    array: "ARRAY",
  };

  const sortie: any = {};
  if (schema.type) sortie.type = TYPES[schema.type] ?? String(schema.type).toUpperCase();
  if (schema.description) sortie.description = schema.description;
  if (schema.enum) sortie.enum = schema.enum;
  if (schema.required?.length) sortie.required = schema.required;
  if (schema.items) sortie.items = convertirSchema(schema.items);
  if (schema.properties) {
    sortie.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([cle, val]) => [cle, convertirSchema(val)])
    );
  }
  return sortie;
}

/** Traduit les tools du projet en functionDeclarations Gemini. */
export function construireOutilsGemini(client: ResolvedClient) {
  const w = client.sectorProfile.workflowsActifs;
  const actifs = TOOLS.filter((t) => {
    if (t.name === "check_calendar_availability" || t.name === "book_appointment") return w.rdv;
    if (t.name === "create_lead") return w.qualification;
    if (t.name === "unsubscribe_contact") return w.newsletter || w.relance;
    return true; // escalate_to_human toujours disponible
  });

  return actifs.map((t) => {
    const schema = convertirSchema(t.input_schema);
    const declaration: any = { name: t.name, description: t.description };
    // Gemini refuse un objet de paramètres vide : on l'omet (cas unsubscribe_contact).
    if (schema?.properties && Object.keys(schema.properties).length > 0) {
      declaration.parameters = schema;
    }
    return declaration;
  });
}

/**
 * Le palier gratuit limite le nombre de requêtes par minute : deux messages
 * WhatsApp rapprochés suffisent à déclencher une 429, alors que la minute
 * suivante repasse. On réessaie donc brièvement avant d'abandonner, plutôt
 * que d'envoyer un message de repli au contact pour une limite transitoire.
 */
async function appelerGemini(corps: unknown): Promise<any> {
  const cle = process.env.GEMINI_API_KEY;
  if (!cle) {
    throw new Error(
      "GEMINI_API_KEY manquant dans .env — crée une clé gratuite sur https://aistudio.google.com/apikey"
    );
  }

  let derniereErreur: any;
  for (let tentative = 1; tentative <= TENTATIVES; tentative++) {
    try {
      const res = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": cle },
        body: JSON.stringify(corps),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.ok) return res.json();

      const details = await res.text();
      derniereErreur = Object.assign(new Error(`Gemini ${res.status}: ${details}`), {
        status: res.status,
      });
      // 429 (quota par minute) et 5xx : transitoires. Le reste ne l'est pas.
      if (res.status !== 429 && res.status < 500) throw derniereErreur;
    } catch (err: any) {
      derniereErreur = err;
      const transitoire =
        err?.status === 429 || err?.status >= 500 || err?.name === "TimeoutError" || err?.cause;
      if (!transitoire) throw err;
    }

    if (tentative < TENTATIVES) {
      const attente = ATTENTE_429_MS * tentative;
      console.warn(
        `Gemini — tentative ${tentative}/${TENTATIVES} (${derniereErreur?.status ?? derniereErreur?.message}), ` +
          `nouvel essai dans ${attente} ms...`
      );
      await new Promise((r) => setTimeout(r, attente));
    }
  }
  throw derniereErreur;
}

export async function converseWithGemini(params: {
  systemPrompt: string;
  ragContext: string;
  history: HistoryMessage[];
  userMessage: string;
  client: ResolvedClient;
  contactId: string;
  contactWhatsappNumber: string;
}): Promise<string> {
  const systemPrompt = `${params.systemPrompt}

--- Base de connaissance pertinente pour ce message ---
${params.ragContext}
--- Fin de la base de connaissance ---

Réponds toujours en français, de façon concise (WhatsApp), sans jamais inventer d'information absente de la base de connaissance ou du contexte.`;

  const contents: GeminiContent[] = [
    ...params.history.map((h) => ({
      role: (h.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: h.content }],
    })),
    { role: "user", parts: [{ text: params.userMessage }] },
  ];

  const outils = construireOutilsGemini(params.client);

  try {
    for (let tour = 0; tour < MAX_TOOL_ROUNDS; tour++) {
      const reponse = await appelerGemini({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(outils.length ? { tools: [{ functionDeclarations: outils }] } : {}),
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.4,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        },
      });

      const candidat = reponse?.candidates?.[0];
      const parts: GeminiPart[] = candidat?.content?.parts ?? [];

      if (parts.length === 0 && candidat?.finishReason === "MAX_TOKENS") {
        console.error(
          `Gemini : budget de sortie épuisé par la réflexion (${reponse?.usageMetadata?.thoughtsTokenCount ?? "?"} tokens) ` +
            `sans produire de réponse. Augmente GEMINI_MAX_OUTPUT_TOKENS (actuel : ${MAX_OUTPUT_TOKENS}).`
        );
        return "Désolé, je n'ai pas pu formuler de réponse. Pouvez-vous reformuler ?";
      }

      const appels = parts.filter((p) => p.functionCall);

      if (appels.length === 0) {
        const texte = parts
          .map((p) => p.text)
          .filter(Boolean)
          .join("\n")
          .trim();
        return texte || "Désolé, je n'ai pas pu formuler de réponse.";
      }

      // Rejoue le tour du modèle, puis renvoie le résultat de chaque outil
      contents.push({ role: "model", parts });

      const resultats: GeminiPart[] = [];
      for (const appel of appels) {
        const brut = await executeTool(appel.functionCall!.name, appel.functionCall!.args ?? {}, {
          client: params.client,
          contactId: params.contactId,
          contactWhatsappNumber: params.contactWhatsappNumber,
        });
        let contenu: Record<string, any>;
        try {
          contenu = JSON.parse(brut);
        } catch {
          contenu = { resultat: brut };
        }
        resultats.push({
          functionResponse: { name: appel.functionCall!.name, response: contenu },
        });
      }
      contents.push({ role: "user", parts: resultats });
    }

    return "Je transmets votre demande à un membre de l'équipe, merci de patienter.";
  } catch (err: any) {
    console.error(`Gemini indisponible — ${expliquerErreurGemini(err)}`);

    if (err?.status === 429) {
      return "Je suis temporairement surchargé. Pouvez-vous réessayer dans quelques instants ?";
    }
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return "Je rencontre une latence temporaire. Un moment svp...";
    }
    return "Désolé, je n'ai pas pu traiter votre demande. Pouvez-vous reformuler ou contactez l'équipe?";
  }
}

/** Traduit une erreur de l'API Gemini en une phrase exploitable. */
export function expliquerErreurGemini(err: any): string {
  const message: string = err?.message ?? String(err);

  if (/GEMINI_API_KEY manquant/.test(message)) return message;
  if (err?.status === 400 && /API key not valid/i.test(message)) {
    return "GEMINI_API_KEY invalide — recrée une clé sur https://aistudio.google.com/apikey.";
  }
  if (err?.status === 429) {
    return "quota gratuit Gemini atteint (limite par minute ou par jour) : réessaie plus tard. " +
      "Le contact a reçu le message de repli.";
  }
  if (err?.status === 404) {
    return `modèle inconnu (GEMINI_MODEL = ${MODEL}) — vérifie l'identifiant dans .env.`;
  }
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `délai de ${TIMEOUT_MS} ms dépassé pour l'appel Gemini (réseau lent).`;
  }
  return message;
}
