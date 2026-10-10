import type { ResolvedClient } from "../orchestrator/resolveClient";

interface LeadPayload {
  nom: string;
  besoin: string;
  budget?: string;
  score: number;
  contactPref?: string;
  whatsappNumber: string;
}

/**
 * Pousse un lead qualifié vers HubSpot en tant que contact + note.
 * Utilise le tier gratuit HubSpot avec des propriétés personnalisées
 * par secteur (à créer une fois par compte HubSpot via l'UI ou l'API Properties).
 */
export async function pushLeadToHubspot(client: ResolvedClient, lead: LeadPayload) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token || !client.hubspotAccountId) {
    console.warn(`HubSpot non connecté pour ${client.nomEntreprise} — lead conservé en base uniquement.`);
    return;
  }

  const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        firstname: lead.nom,
        phone: lead.whatsappNumber,
        hs_lead_status: lead.score >= 70 ? "CHAUD" : "NOUVEAU",
        // Propriétés personnalisées par secteur — à créer côté HubSpot
        besoin_exprime: lead.besoin,
        budget_indicatif: lead.budget ?? "",
        score_qualification: lead.score,
        canal_source: "whatsapp",
      },
    }),
  });

  if (!res.ok) {
    console.error(`Échec push HubSpot: ${res.status} ${await res.text()}`);
  }
}
