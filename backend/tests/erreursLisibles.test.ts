import { describe, it, expect } from "vitest";
import { expliquerErreurMeta } from "../src/integrations/whatsapp";
import { expliquerErreurClaude } from "../src/llm/converse";

/**
 * Ces messages sont ce que l'exploitant lit en console quand un envoi échoue.
 * Ils doivent dire quoi faire, pas seulement ce qui s'est passé.
 */
describe("expliquerErreurMeta — diagnostics WhatsApp actionnables", () => {
  const corps = (code: number, message = "erreur") =>
    JSON.stringify({ error: { message, code, type: "OAuthException" } });

  it("131030 : destinataire absent de la liste autorisée du numéro de test", () => {
    const texte = expliquerErreurMeta(400, corps(131030));
    expect(texte).toContain("liste autorisée");
    expect(texte).toContain("API Setup");
  });

  it("190 : token expiré, avec la marche à suivre", () => {
    const texte = expliquerErreurMeta(401, corps(190));
    expect(texte).toContain("expiré");
    expect(texte).toContain("WHATSAPP_ACCESS_TOKEN");
  });

  it("131047 : fenêtre de 24 h écoulée, un template devient obligatoire", () => {
    expect(expliquerErreurMeta(400, corps(131047))).toContain("template");
  });

  it("code inconnu : on conserve le message de Meta plutôt que de le masquer", () => {
    const texte = expliquerErreurMeta(500, corps(999999, "Panne interne Meta"));
    expect(texte).toContain("Panne interne Meta");
  });

  it("corps non-JSON : aucune exception, le texte brut est conservé", () => {
    expect(expliquerErreurMeta(502, "<html>Bad Gateway</html>")).toContain("Bad Gateway");
  });
});

describe("expliquerErreurClaude — diagnostics Anthropic actionnables", () => {
  it("solde épuisé : indique où recharger et rassure sur le repli envoyé", () => {
    const err = {
      status: 400,
      error: { error: { message: "Your credit balance is too low to access the Anthropic API." } },
    };
    const texte = expliquerErreurClaude(err);
    expect(texte).toContain("crédits");
    expect(texte).toContain("Plans & Billing");
    expect(texte).toContain("repli");
  });

  it("clé invalide", () => {
    expect(expliquerErreurClaude({ status: 401, message: "authentication error" })).toContain(
      "ANTHROPIC_API_KEY"
    );
  });

  it("limite de débit", () => {
    expect(expliquerErreurClaude({ status: 429, message: "rate limited" })).toContain("débit");
  });

  it("erreur inconnue : le message d'origine reste visible", () => {
    expect(expliquerErreurClaude(new Error("panique inattendue"))).toContain("panique inattendue");
  });
});
