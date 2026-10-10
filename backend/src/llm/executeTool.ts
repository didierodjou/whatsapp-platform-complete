import { withTenant } from "../db/pool";
import { checkAvailability, createCalendarEvent } from "../integrations/calendar";
import { pushLeadToHubspot } from "../integrations/hubspot";
import { notifyEscalation } from "../escalation/notify";
import type { ResolvedClient } from "../orchestrator/resolveClient";

interface ToolContext {
  client: ResolvedClient;
  contactId: string;
  contactWhatsappNumber: string;
}

export async function executeTool(
  toolName: string,
  input: Record<string, any>,
  ctx: ToolContext
): Promise<string> {
  switch (toolName) {
    case "check_calendar_availability": {
      try {
        const slots = await checkAvailability(ctx.client, input.date_debut, input.date_fin);
        return JSON.stringify({ creneaux_disponibles: slots });
      } catch (err: any) {
        // R2: Return error message Claude can understand
        console.error("Calendar availability error:", err.message);
        return JSON.stringify({ 
          erreur: "Calendrier temporairement indisponible. " +
                  "Merci de contacter l'équipe commerciale pour un créneau."
        });
      }
    }

    case "book_appointment": {
      const event = await createCalendarEvent(ctx.client, input.datetime, input.motif);
      if (!event) throw new Error("Création de l'événement Google impossible.");
      await withTenant(ctx.client.id, (db) =>
        db.query(
          `INSERT INTO rendez_vous (contact_id, client_id, datetime, motif, champs_specifiques, google_event_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ctx.contactId,
            ctx.client.id,
            input.datetime,
            input.motif,
            input.champs_specifiques ?? {},
            event.id,
          ]
        )
      );
      return JSON.stringify({ statut: "confirme", datetime: input.datetime });
    }

    case "create_lead": {
      await withTenant(ctx.client.id, (db) =>
        db.query(`UPDATE contacts SET score_lead = $1 WHERE id = $2`, [input.score, ctx.contactId])
      );
      await pushLeadToHubspot(ctx.client, {
        nom: input.nom,
        besoin: input.besoin,
        budget: input.budget,
        score: input.score,
        contactPref: input.contact_pref,
        whatsappNumber: ctx.contactWhatsappNumber,
      });
      if (input.score >= 70) {
        await notifyEscalation(ctx.client, {
          resume: `Lead chaud : ${input.nom} — ${input.besoin} (score ${input.score})`,
          urgence: "normale",
        });
      }
      return JSON.stringify({ statut: "lead_enregistre" });
    }

    case "escalate_to_human": {
      await withTenant(ctx.client.id, async (db) => {
        await db.query(
          `INSERT INTO escalades (contact_id, client_id, resume, urgence) VALUES ($1, $2, $3, $4)`,
          [ctx.contactId, ctx.client.id, input.resume, input.urgence]
        );
        await db.query(`UPDATE contacts SET statut = 'escalade' WHERE id = $1`, [ctx.contactId]);
      });
      await notifyEscalation(ctx.client, { resume: input.resume, urgence: input.urgence });
      return JSON.stringify({ statut: "escalade_creee" });
    }

    case "unsubscribe_contact": {
      await withTenant(ctx.client.id, (db) =>
        db.query(`UPDATE contacts SET opt_in_marketing = false WHERE id = $1`, [ctx.contactId])
      );
      return JSON.stringify({ statut: "desinscrit" });
    }

    default:
      return JSON.stringify({ erreur: `Tool inconnu: ${toolName}` });
  }
}
