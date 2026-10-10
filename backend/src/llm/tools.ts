import Anthropic from "@anthropic-ai/sdk";

/**
 * Déclaration des tools exposés à Claude. L'exécution réelle est faite
 * dans tools.execute.ts — ce fichier ne contient que le schéma.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "check_calendar_availability",
    description:
      "Vérifie les créneaux disponibles dans l'agenda du client sur une plage de dates donnée.",
    input_schema: {
      type: "object",
      properties: {
        date_debut: { type: "string", description: "Date de début ISO 8601 (ex: 2026-08-25)" },
        date_fin: { type: "string", description: "Date de fin ISO 8601" },
      },
      required: ["date_debut", "date_fin"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Crée un rendez-vous confirmé dans l'agenda et l'enregistre en base. À utiliser seulement après confirmation explicite du contact.",
    input_schema: {
      type: "object",
      properties: {
        datetime: { type: "string", description: "Date et heure ISO 8601 du rendez-vous" },
        motif: { type: "string", description: "Motif du rendez-vous" },
        champs_specifiques: {
          type: "object",
          description:
            "Champs additionnels propres au secteur (ex: couverts/allergies pour un restaurant, type_bien/budget pour l'immobilier).",
        },
      },
      required: ["datetime", "motif"],
    },
  },
  {
    name: "create_lead",
    description:
      "Enregistre un prospect qualifié en base et le pousse vers le CRM (HubSpot). Utilise un score de 0 à 100 reflétant la maturité du besoin.",
    input_schema: {
      type: "object",
      properties: {
        nom: { type: "string" },
        besoin: { type: "string", description: "Résumé du besoin exprimé" },
        budget: { type: "string" },
        score: { type: "integer", description: "Score de qualification, 0 à 100" },
        contact_pref: { type: "string", description: "Canal ou horaire de contact préféré" },
      },
      required: ["nom", "besoin", "score"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Transfère la conversation à un humain et suspend les réponses automatiques. À utiliser pour toute demande hors périmètre, urgence, ou litige.",
    input_schema: {
      type: "object",
      properties: {
        resume: { type: "string", description: "Résumé de la situation pour l'équipe humaine" },
        urgence: { type: "string", enum: ["basse", "normale", "haute"] },
      },
      required: ["resume", "urgence"],
    },
  },
  {
    name: "unsubscribe_contact",
    description:
      "Désinscrit le contact des communications marketing/newsletter (ex: réponse 'STOP'). N'affecte pas le SAV.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];
