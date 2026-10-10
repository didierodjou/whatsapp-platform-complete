import crypto from "crypto";
import type { ResolvedClient } from "../orchestrator/resolveClient";

const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v20.0";
const TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS ?? 20_000);
const TENTATIVES = 3;

/**
 * Envoie une requête à la Graph API en réessayant les seules pannes où la
 * requête n'a vraisemblablement pas abouti : coupure réseau (`fetch failed`),
 * délai dépassé, ou erreur serveur Meta. Observé en conditions réelles — un
 * simple `fetch failed` faisait perdre définitivement une réponse déjà
 * générée et déjà payée.
 *
 * Les erreurs 4xx (destinataire non autorisé, token expiré, fenêtre 24 h) ne
 * sont jamais réessayées : elles ne se résoudront pas d'elles-mêmes.
 *
 * Compromis assumé : la Cloud API n'offre pas de clé d'idempotence. Si Meta
 * a traité l'envoi mais que la réponse s'est perdue en route, le renvoi peut
 * produire un doublon — préférable à la perte silencieuse du message.
 */
/**
 * Redirige TOUS les envois vers un numéro unique quand la variable est
 * renseignée. Deux usages :
 *  - environnement de test : ne jamais écrire à un vrai contact par erreur ;
 *  - numéro de test Meta : la liste blanche compare la chaîne fournie, pas
 *    l'identifiant WhatsApp. Un numéro enregistré avec un préfixe national
 *    superflu (ex. « 789526035212 » pour +7 952 603 5212) n'est donc joignable
 *    que sous cette forme, alors que le webhook nous transmet « 79526035212 ».
 *
 * À laisser vide en production : les réponses doivent partir vers l'expéditeur.
 */
function destinataireEffectif(numeroDemande: string): string {
  const redirection = process.env.WHATSAPP_RECIPIENT_OVERRIDE?.trim();
  if (!redirection || redirection === numeroDemande) return numeroDemande;
  console.warn(
    `WHATSAPP_RECIPIENT_OVERRIDE actif : message destiné à ${numeroDemande} redirigé vers ${redirection}.`
  );
  return redirection;
}

function jetonAcces(): string | undefined {
  // Lu à chaque appel : le token WhatsApp est la valeur qui change le plus
  // souvent (24 h sur un numéro de test). Le lire au chargement du module
  // rendait le comportement dépendant de l'ordre des imports et intestable.
  return process.env.WHATSAPP_ACCESS_TOKEN;
}

async function appelerGraphApi(url: string, corps: unknown): Promise<Response> {
  let derniereErreur: unknown;

  for (let tentative = 1; tentative <= TENTATIVES; tentative++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jetonAcces()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(corps),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status >= 500 || res.status === 429) {
        derniereErreur = new Error(`Graph API ${res.status}`);
        if (tentative < TENTATIVES) {
          console.warn(
            `Envoi WhatsApp — tentative ${tentative}/${TENTATIVES} : Meta a répondu ${res.status}, nouvel essai...`
          );
          await new Promise((r) => setTimeout(r, 700 * tentative));
          continue;
        }
      }
      return res;
    } catch (err: any) {
      derniereErreur = err;
      if (tentative === TENTATIVES) break;
      console.warn(
        `Envoi WhatsApp — tentative ${tentative}/${TENTATIVES} échouée (${err?.message ?? err}), nouvel essai...`
      );
      await new Promise((r) => setTimeout(r, 700 * tentative));
    }
  }
  throw derniereErreur;
}

/** Vérifie la signature X-Hub-Signature-256 envoyée par Meta sur chaque webhook. */
export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !process.env.WHATSAPP_APP_SECRET) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Traduit une erreur de la Graph API en une phrase actionnable.
 * Sans ça, un simple « numéro absent de la liste autorisée » se présentait
 * sous la forme d'un JSON Meta imbriqué de 15 lignes, illisible en console.
 */
export function expliquerErreurMeta(status: number, corps: string): string {
  let code: number | undefined;
  let message = corps;
  try {
    const json = JSON.parse(corps);
    code = json?.error?.code;
    message = json?.error?.message ?? corps;
  } catch {
    /* corps non-JSON : on garde le texte brut */
  }

  const explications: Record<number, string> = {
    131030:
      "le numéro du destinataire n'est pas dans la liste autorisée de ton numéro de test Meta. " +
      "Ajoute-le dans Meta for Developers > WhatsApp > API Setup > champ « To ».",
    190:
      "le token WhatsApp est expiré ou invalide. Génère un token System User (60 jours) " +
      "et mets à jour WHATSAPP_ACCESS_TOKEN dans .env, puis redémarre le serveur.",
    131047:
      "la fenêtre de 24 h est écoulée pour ce contact : seul un template approuvé par Meta " +
      "peut encore lui être envoyé (sendWhatsappTemplate).",
    131026:
      "le message est indélivrable — le numéro destinataire n'a probablement pas de compte WhatsApp.",
    130429: "limite de débit Meta atteinte : réessaie dans quelques instants.",
    100:
      "paramètre invalide — vérifie le whatsapp_phone_number_id du client " +
      "(Meta > WhatsApp > API Setup > Phone number ID).",
  };

  const conseil = code ? explications[code] : undefined;
  return conseil
    ? `WhatsApp (${status}, code ${code}) : ${conseil}`
    : `WhatsApp (${status}) : ${message}`;
}

export interface ParsedInboundMessage {
  toPhoneNumberId: string; // identifie le numéro Business (mappé à whatsapp_phone_number_id)
  toDisplayNumber: string;
  fromNumber: string;
  text: string | null;
  type: string;
}

/** Parse le payload webhook Meta et extrait les messages texte/boutons/listes. */
export function parseWebhookPayload(body: any): ParsedInboundMessage[] {
  const messages: ParsedInboundMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const metadata = value?.metadata;
      for (const msg of value?.messages ?? []) {
        let text: string | null = null;
        if (msg.type === "text") text = msg.text?.body ?? null;
        else if (msg.type === "interactive") {
          text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
        } else if (msg.type === "image") {
          text = "[Image reçue]"; // accusé de réception seulement, cf. section 3.1 du brief
        }
        messages.push({
          toPhoneNumberId: metadata?.phone_number_id,
          toDisplayNumber: metadata?.display_phone_number,
          fromNumber: msg.from,
          text,
          type: msg.type,
        });
      }
    }
  }
  return messages;
}

export async function sendWhatsappText(client: ResolvedClient, toNumber: string, text: string) {
  if (!client.whatsappPhoneNumberId) {
    throw new Error(`Client ${client.nomEntreprise} sans whatsapp_phone_number_id configuré.`);
  }
  if (!jetonAcces()) throw new Error("WHATSAPP_ACCESS_TOKEN n'est pas configuré.");
  const res = await appelerGraphApi(
    `https://graph.facebook.com/${API_VERSION}/${client.whatsappPhoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: destinataireEffectif(toNumber),
      type: "text",
      text: { body: text },
    }
  );
  if (!res.ok) {
    throw new Error(`Échec envoi WhatsApp — ${expliquerErreurMeta(res.status, await res.text())}`);
  }
}

/** Envoi d'un template approuvé (hors fenêtre 24h — newsletter, rappels, relances). */
export async function sendWhatsappTemplate(
  client: ResolvedClient,
  toNumber: string,
  templateName: string,
  languageCode = "fr",
  components: any[] = []
) {
  if (!client.whatsappPhoneNumberId) {
    throw new Error(`Client ${client.nomEntreprise} sans whatsapp_phone_number_id configuré.`);
  }
  if (!jetonAcces()) throw new Error("WHATSAPP_ACCESS_TOKEN n'est pas configuré.");
  const res = await appelerGraphApi(
    `https://graph.facebook.com/${API_VERSION}/${client.whatsappPhoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: destinataireEffectif(toNumber),
      type: "template",
      template: { name: templateName, language: { code: languageCode }, components },
    }
  );
  if (!res.ok) {
    throw new Error(
      `Échec envoi template WhatsApp « ${templateName} » — ${expliquerErreurMeta(
        res.status,
        await res.text()
      )}`
    );
  }
}
