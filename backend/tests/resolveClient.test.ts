import { describe, it, expect } from "vitest";
import { buildSystemPrompt, ResolvedClient } from "../src/orchestrator/resolveClient";

function fakeClient(overrides: Partial<ResolvedClient> = {}): ResolvedClient {
  return {
    id: "client-1",
    nomEntreprise: "Chez Amara",
    statut: "actif",
    whatsappPhoneNumberId: "123",
    googleCalendarId: null,
    hubspotAccountId: null,
    sectorProfile: {
      id: "sector-1",
      nomSecteur: "restaurant",
      workflowsActifs: { sav: true, rdv: true },
      champsRdv: ["couverts", "date"],
      templateSystemPrompt: "Tu es l'assistant de {{nom_entreprise}}. Horaires: {{horaires}}.",
      tonParDefaut: "Chaleureux",
    },
    variablesPrompt: { horaires: "11h-22h" },
    ...overrides,
  };
}

describe("buildSystemPrompt — résolution du bon profil sectoriel", () => {
  it("injecte le nom d'entreprise et les variables client dans le template", () => {
    const prompt = buildSystemPrompt(fakeClient());
    expect(prompt).toContain("Tu es l'assistant de Chez Amara");
    expect(prompt).toContain("Horaires: 11h-22h");
  });

  it("signale une variable manquante au lieu d'échouer silencieusement", () => {
    const client = fakeClient({ variablesPrompt: {} });
    const prompt = buildSystemPrompt(client);
    expect(prompt).toContain("[horaires non renseigné]");
  });

  it("deux clients de secteurs différents produisent des prompts différents", () => {
    const restaurant = buildSystemPrompt(fakeClient());
    const dentaire = buildSystemPrompt(
      fakeClient({
        nomEntreprise: "Clinique Dentaire Plus",
        sectorProfile: {
          id: "sector-2",
          nomSecteur: "dentaire",
          workflowsActifs: { sav: true, rdv: true },
          champsRdv: ["motif", "urgence"],
          templateSystemPrompt: "Tu es l'assistant de {{nom_entreprise}}, une clinique dentaire.",
          tonParDefaut: "Rassurant",
        },
        variablesPrompt: {},
      })
    );
    expect(restaurant).not.toEqual(dentaire);
    expect(dentaire).toContain("clinique dentaire");
  });
});
