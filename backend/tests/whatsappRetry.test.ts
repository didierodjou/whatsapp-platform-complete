import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWhatsappText } from "../src/integrations/whatsapp";
import type { ResolvedClient } from "../src/orchestrator/resolveClient";

const client = { nomEntreprise: "ITARE", whatsappPhoneNumberId: "pn123" } as ResolvedClient;

let fetchMock: any;
beforeEach(() => {
  process.env.WHATSAPP_ACCESS_TOKEN = "tok";
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Laisse passer les attentes entre deux tentatives sans ralentir le test. */
async function avecTempsAccelere<T>(p: Promise<T>): Promise<T> {
  const attente = p;
  await vi.runAllTimersAsync();
  return attente;
}

describe("sendWhatsappText — la réponse n'est plus perdue sur une coupure réseau", () => {
  it("réessaie après un 'fetch failed' et aboutit", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await avecTempsAccelere(sendWhatsappText(client, "79526035212", "Voici nos desserts"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("réessaie sur une erreur serveur Meta (5xx)", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "indispo" })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await avecTempsAccelere(sendWhatsappText(client, "79526035212", "coucou"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ne réessaie JAMAIS une erreur 4xx : elle ne se résoudra pas seule", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 131030, message: "not in allowed list" } }),
    });

    await expect(
      avecTempsAccelere(sendWhatsappText(client, "79526035212", "coucou"))
    ).rejects.toThrow(/liste autorisée/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("abandonne après 3 tentatives et remonte l'erreur", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      avecTempsAccelere(sendWhatsappText(client, "79526035212", "coucou"))
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("borne l'attente réseau au lieu de rester suspendu indéfiniment", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await avecTempsAccelere(sendWhatsappText(client, "79526035212", "coucou"));
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });
});

describe("WHATSAPP_RECIPIENT_OVERRIDE — redirection des envois en environnement de test", () => {
  afterEach(() => delete process.env.WHATSAPP_RECIPIENT_OVERRIDE);

  it("redirige le destinataire quand la variable est renseignée", async () => {
    process.env.WHATSAPP_RECIPIENT_OVERRIDE = "789526035212";
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await avecTempsAccelere(sendWhatsappText(client, "79526035212", "Voici nos desserts"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe("789526035212");
  });

  it("n'altère rien quand la variable est absente (comportement de production)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await avecTempsAccelere(sendWhatsappText(client, "79526035212", "coucou"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe("79526035212");
  });

  it("ignore une variable vide", async () => {
    process.env.WHATSAPP_RECIPIENT_OVERRIDE = "   ";
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await avecTempsAccelere(sendWhatsappText(client, "79526035212", "coucou"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe("79526035212");
  });
});
