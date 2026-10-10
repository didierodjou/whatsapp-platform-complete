import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import { verifyMetaSignature, parseWebhookPayload } from "../src/integrations/whatsapp";

beforeAll(() => {
  process.env.WHATSAPP_APP_SECRET = "test_secret";
});

describe("verifyMetaSignature — sécurité du webhook", () => {
  it("accepte une signature valide", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const sig =
      "sha256=" + crypto.createHmac("sha256", "test_secret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig)).toBe(true);
  });

  it("rejette une signature invalide", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(verifyMetaSignature(body, "sha256=invalide")).toBe(false);
  });

  it("rejette une requête sans signature", () => {
    const body = Buffer.from("{}");
    expect(verifyMetaSignature(body, undefined)).toBe(false);
  });
});

describe("parseWebhookPayload — réception de message", () => {
  it("extrait un message texte simple avec le numéro Business destinataire", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn123", display_phone_number: "+2250700000000" },
                messages: [{ from: "+2250711111111", type: "text", text: { body: "Bonjour" } }],
              },
            },
          ],
        },
      ],
    };
    const messages = parseWebhookPayload(payload);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Bonjour");
    expect(messages[0].toDisplayNumber).toBe("+2250700000000");
    expect(messages[0].fromNumber).toBe("+2250711111111");
  });

  it("extrait le titre d'un bouton interactif", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn123", display_phone_number: "+2250700000000" },
                messages: [
                  {
                    from: "+2250711111111",
                    type: "interactive",
                    interactive: { button_reply: { title: "Confirmer" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = parseWebhookPayload(payload);
    expect(messages[0].text).toBe("Confirmer");
  });
});
