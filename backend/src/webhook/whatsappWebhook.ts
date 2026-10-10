import { Router } from "express";
import { verifyMetaSignature, parseWebhookPayload } from "../integrations/whatsapp";
import { handleIncomingMessage } from "../orchestrator/handleIncomingMessage";

export const whatsappWebhookRouter = Router();

// Vérification initiale du webhook par Meta (hub.challenge)
whatsappWebhookRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Réception des messages entrants
whatsappWebhookRouter.post("/webhook", async (req, res) => {
  // req.rawBody est peuplé par le middleware express.json({ verify: ... }) — voir server.ts
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!verifyMetaSignature((req as any).rawBody, signature)) {
    return res.sendStatus(401);
  }

  // Répond immédiatement à Meta (règle des 20s) puis traite en tâche de fond
  res.sendStatus(200);

  try {
    const messages = parseWebhookPayload(req.body);
    for (const msg of messages) {
      if (!msg.text) continue;
      await handleIncomingMessage({
        toWhatsappBusinessNumber: msg.toDisplayNumber,
        fromWhatsappNumber: msg.fromNumber,
        text: msg.text,
      });
    }
  } catch (err: any) {
    // Le serveur reste debout : on journalise une ligne lisible, la pile
    // complète n'apporte rien quand la cause est déjà explicite.
    console.error(`Traitement du message interrompu — ${err?.message ?? err}`);
  }
});
