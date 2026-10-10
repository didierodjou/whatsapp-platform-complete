import { pool } from "../db/pool";

export interface ResolvedClient {
  id: string;
  nomEntreprise: string;
  statut: string;
  whatsappPhoneNumberId: string | null;
  googleCalendarId: string | null;
  hubspotAccountId: string | null;
  sectorProfile: {
    id: string;
    nomSecteur: string;
    workflowsActifs: Record<string, boolean>;
    champsRdv: string[];
    templateSystemPrompt: string;
    tonParDefaut: string;
  };
  variablesPrompt: Record<string, string>;
}

/**
 * Étape 1 de la résolution : identifier le client à partir du numéro
 * WhatsApp Business qui a reçu le message (colonne `to` du webhook Meta).
 *
 * La comparaison ignore le formatage : Meta expose le même numéro sous des
 * formes différentes selon la source (`+1 555-678-3446` via la Graph API,
 * `15556783446` dans `metadata.display_phone_number` du webhook), et un
 * numéro saisi à la main lors de l'onboarding contient souvent des espaces.
 * Une égalité stricte faisait échouer la résolution en silence — le message
 * était simplement ignoré. Une correspondance exacte reste prioritaire si
 * deux clients se ramènent aux mêmes chiffres.
 */
export async function resolveClientByWhatsappNumber(
  whatsappBusinessNumber: string
): Promise<ResolvedClient | null> {
  const { rows } = await pool.query(
    `SELECT c.id, c.nom_entreprise, c.statut, c.whatsapp_phone_number_id,
            c.google_calendar_id, c.hubspot_account_id, c.variables_prompt,
            sp.id AS sector_id, sp.nom_secteur, sp.workflows_actifs,
            sp.champs_rdv, sp.template_system_prompt, sp.ton_par_defaut
     FROM clients c
     JOIN sector_profiles sp ON sp.id = c.sector_profile_id
     WHERE c.whatsapp_business_number = $1
        OR regexp_replace(c.whatsapp_business_number, '[^0-9]', '', 'g')
           = regexp_replace($1, '[^0-9]', '', 'g')
     ORDER BY (c.whatsapp_business_number = $1) DESC
     LIMIT 1`,
    [whatsappBusinessNumber]
  );

  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    id: r.id,
    nomEntreprise: r.nom_entreprise,
    statut: r.statut,
    whatsappPhoneNumberId: r.whatsapp_phone_number_id,
    googleCalendarId: r.google_calendar_id,
    hubspotAccountId: r.hubspot_account_id,
    sectorProfile: {
      id: r.sector_id,
      nomSecteur: r.nom_secteur,
      workflowsActifs: r.workflows_actifs,
      champsRdv: r.champs_rdv,
      templateSystemPrompt: r.template_system_prompt,
      tonParDefaut: r.ton_par_defaut,
    },
    variablesPrompt: r.variables_prompt || {},
  };
}

/**
 * Étapes 2-3 : injecte les variables client dans le template sectoriel.
 * {{nom_entreprise}} vient toujours de clients.nom_entreprise ;
 * les autres variables ({{horaires}}, {{tarifs}}, ...) viennent de
 * clients.variables_prompt.
 */
export function buildSystemPrompt(client: ResolvedClient): string {
  const vars: Record<string, string> = {
    nom_entreprise: client.nomEntreprise,
    ...client.variablesPrompt,
  };

  return client.sectorProfile.templateSystemPrompt.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => vars[key] ?? `[${key} non renseigné]`
  );
}
