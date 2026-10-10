import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn(async () => JSON.stringify({ statut: "ok" })));
vi.mock("../src/llm/executeTool", () => ({ executeTool: executeToolMock }));

import { converseWithGemini, construireOutilsGemini, expliquerErreurGemini } from "../src/llm/gemini";
import type { ResolvedClient } from "../src/orchestrator/resolveClient";

function client(overrides: Partial<ResolvedClient["sectorProfile"]> = {}): ResolvedClient {
  return {
    id: "c1",
    nomEntreprise: "ITARE",
    statut: "actif",
    whatsappPhoneNumberId: "pn",
    googleCalendarId: null,
    hubspotAccountId: null,
    sectorProfile: {
      id: "s1",
      nomSecteur: "restaurant",
      workflowsActifs: { sav: true, rdv: true, qualification: false, relance: true, newsletter: false },
      champsRdv: [],
      templateSystemPrompt: "",
      tonParDefaut: "",
      ...overrides,
    },
    variablesPrompt: {},
  };
}

const params = (texte = "Bonjour") => ({
  systemPrompt: "Tu es l'assistant d'ITARE.",
  ragContext: "Le menu du jour est à 3500 FCFA.",
  history: [{ role: "assistant" as const, content: "Bonjour !" }],
  userMessage: texte,
  client: client(),
  contactId: "ct1",
  contactWhatsappNumber: "+33900000000",
});

const reponseTexte = (t: string) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: t }] } }] }),
});
const reponseOutil = (name: string, args: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] }),
});

let fetchMock: any;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "cle_test";
  executeToolMock.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("construireOutilsGemini — conversion des schémas vers le format Google", () => {
  it("traduit les types JSON Schema en types OpenAPI majuscules", () => {
    const outils = construireOutilsGemini(client());
    const rdv = outils.find((o: any) => o.name === "book_appointment")!;
    expect(rdv.parameters.type).toBe("OBJECT");
    expect(rdv.parameters.properties.datetime.type).toBe("STRING");
    expect(rdv.parameters.required).toContain("datetime");
  });

  it("omet les paramètres quand l'outil n'en a aucun (Gemini rejette un objet vide)", () => {
    const outil = construireOutilsGemini(client())!.find((o: any) => o.name === "unsubscribe_contact");
    expect(outil).toBeDefined();
    expect(outil).not.toHaveProperty("parameters");
  });

  it("respecte les workflows du secteur", () => {
    const noms = (c: ResolvedClient) => construireOutilsGemini(c).map((o: any) => o.name);
    expect(noms(client())).toContain("book_appointment");
    expect(noms(client())).not.toContain("create_lead");

    const immo = client({ workflowsActifs: { sav: false, rdv: true, qualification: true, relance: false, newsletter: false } });
    expect(noms(immo)).toContain("create_lead");
  });

  it("conserve les valeurs d'énumération", () => {
    const esc = construireOutilsGemini(client()).find((o: any) => o.name === "escalate_to_human")!;
    expect(esc.parameters.properties.urgence.enum).toEqual(["basse", "normale", "haute"]);
  });
});

describe("converseWithGemini — boucle conversationnelle", () => {
  it("renvoie le texte final et transmet system prompt, contexte RAG et historique", async () => {
    fetchMock.mockResolvedValueOnce(reponseTexte("Le menu du jour est à 3500 FCFA."));

    const texte = await converseWithGemini(params("Le prix du menu ?"));
    expect(texte).toContain("3500 FCFA");

    const corps = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corps.systemInstruction.parts[0].text).toContain("ITARE");
    expect(corps.systemInstruction.parts[0].text).toContain("3500 FCFA");
    // l'historique "assistant" devient le rôle "model" attendu par Gemini
    expect(corps.contents[0]).toMatchObject({ role: "model" });
    expect(corps.contents.at(-1)).toMatchObject({ role: "user" });
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe("cle_test");
  });

  it("exécute l'outil demandé puis renvoie sa réponse au modèle", async () => {
    fetchMock
      .mockResolvedValueOnce(reponseOutil("book_appointment", { datetime: "2026-09-10T18:00:00Z", motif: "Table pour 4" }))
      .mockResolvedValueOnce(reponseTexte("C'est réservé !"));

    const texte = await converseWithGemini(params("Une table pour 4"));
    expect(texte).toBe("C'est réservé !");
    expect(executeToolMock).toHaveBeenCalledWith(
      "book_appointment",
      expect.objectContaining({ motif: "Table pour 4" }),
      expect.objectContaining({ contactId: "ct1" })
    );

    // Le second appel rejoue le tour du modèle puis la réponse de l'outil
    const corps = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(corps.contents.at(-2).role).toBe("model");
    expect(corps.contents.at(-1).parts[0].functionResponse).toMatchObject({
      name: "book_appointment",
      response: { statut: "ok" },
    });
  });

  it("réflexion qui épuise le budget de sortie : réponse de repli, pas un message vide", async () => {
    // Cas réellement observé sur gemini-3.6-flash : contenu vide + MAX_TOKENS
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: {}, finishReason: "MAX_TOKENS" }],
        usageMetadata: { thoughtsTokenCount: 285 },
      }),
    });
    const texte = await converseWithGemini(params());
    expect(texte).toContain("Pouvez-vous reformuler");
  });

  it("envoie un niveau de réflexion bas et un budget de sortie suffisant", async () => {
    fetchMock.mockResolvedValueOnce(reponseTexte("ok"));
    await converseWithGemini(params());
    const corps = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corps.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
    expect(corps.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(2048);
  });

  it("quota par minute (429) : réessaie et aboutit sans déranger le contact", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "quota exceeded" })
      .mockResolvedValueOnce(reponseTexte("Voici nos desserts"));

    const promesse = converseWithGemini(params());
    await vi.runAllTimersAsync();
    expect(await promesse).toBe("Voici nos desserts");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("quota durablement dépassé : message de repli après 3 tentatives", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "quota exceeded" });

    const promesse = converseWithGemini(params());
    await vi.runAllTimersAsync();
    expect(await promesse).toContain("temporairement surchargé");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("erreur non transitoire (400) : abandon immédiat, sans réessayer", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "API key not valid" });
    const texte = await converseWithGemini(params());
    expect(texte).toContain("Désolé");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clé absente : repli générique plutôt qu'un plantage", async () => {
    delete process.env.GEMINI_API_KEY;
    const texte = await converseWithGemini(params());
    expect(texte).toContain("Désolé");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("s'arrête après 4 tours d'outils au lieu de boucler indéfiniment", async () => {
    fetchMock.mockResolvedValue(reponseOutil("escalate_to_human", { resume: "x", urgence: "basse" }));
    const texte = await converseWithGemini(params());
    expect(texte).toContain("transmets votre demande");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("expliquerErreurGemini", () => {
  it("quota gratuit atteint", () => {
    expect(expliquerErreurGemini({ status: 429, message: "429" })).toContain("quota gratuit");
  });
  it("clé invalide", () => {
    expect(expliquerErreurGemini({ status: 400, message: "API key not valid" })).toContain("GEMINI_API_KEY");
  });
  it("clé absente : le message d'origine est conservé tel quel, avec l'URL de création", () => {
    const err = new Error(
      "GEMINI_API_KEY manquant dans .env — crée une clé gratuite sur https://aistudio.google.com/apikey"
    );
    expect(expliquerErreurGemini(err)).toContain("aistudio.google.com/apikey");
  });
});
