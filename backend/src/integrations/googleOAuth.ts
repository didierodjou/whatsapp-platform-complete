import { Router } from "express";
import { google } from "googleapis";
import { pool } from "../db/pool";
import { encryptJSON, decryptJSON } from "../utils/encryption";
import { asyncRoute } from "../utils/asyncRoute";

export const googleOAuthRouter = Router();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Étape 1 — à ouvrir par le client (ou par toi en son nom) dans un navigateur :
 * GET /oauth/google/start?client_id=<uuid>
 * Redirige vers l'écran de consentement Google. Le client_id est encodé dans
 * `state` pour qu'on sache à qui rattacher les tokens au retour.
 */
googleOAuthRouter.get("/oauth/google/start", asyncRoute(async (req, res) => {
  const clientId = req.query.client_id as string;
  if (!clientId) return res.status(400).send("client_id manquant.");

  const { rows } = await pool.query(`SELECT id FROM clients WHERE id = $1`, [clientId]);
  if (rows.length === 0) return res.status(404).send("Client introuvable.");

  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline", // nécessaire pour obtenir un refresh_token
    prompt: "consent", // force le renvoi du refresh_token même en re-connexion
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: clientId,
  });

  res.redirect(url);
}));

/**
 * Étape 2 — callback appelé par Google après consentement.
 * Échange le code contre des tokens et les stocke sur le client, ainsi que
 * l'agenda principal (calendarId "primary" par défaut, ajustable ensuite).
 */
googleOAuthRouter.get("/oauth/google/callback", asyncRoute(async (req, res) => {
  const code = req.query.code as string;
  const clientId = req.query.state as string;

  if (!code || !clientId) {
    return res.status(400).send("Paramètres manquants (code ou state).");
  }

  const oauth2Client = getOAuthClient();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Récupère l'agenda principal du compte Google connecté
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const calendarList = await calendar.calendarList.get({ calendarId: "primary" });
    const googleCalendarId = calendarList.data.id ?? "primary";

    await pool.query(
      `UPDATE clients SET google_oauth_tokens = $1, google_calendar_id = $2 WHERE id = $3`,
      [encryptJSON(tokens), googleCalendarId, clientId]
    );

    res.send(
      `<html><body style="font-family:sans-serif;padding:2rem">
        <h2>Google Calendar connecté ✅</h2>
        <p>Tu peux fermer cette fenêtre. Le client peut recevoir des rendez-vous automatiquement.</p>
      </body></html>`
    );
  } catch (err) {
    console.error("Échec OAuth Google:", err);
    res.status(500).send("Échec de la connexion Google Calendar. Réessaie depuis /oauth/google/start.");
  }
}));

/**
 * Rafraîchit et persiste le access_token si besoin — à appeler avant tout
 * usage de l'agenda (voir integrations/calendar.ts). `storedTokens` est déjà
 * déchiffré par l'appelant (calendar.ts).
 */
export async function getFreshTokens(clientId: string, storedTokens: any) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(storedTokens);

  // La lib rafraîchit automatiquement si expiré ; on capture le nouveau token
  // et le re-chiffre avant de le persister.
  oauth2Client.on("tokens", async (newTokens) => {
    const merged = { ...storedTokens, ...newTokens };
    await pool.query(`UPDATE clients SET google_oauth_tokens = $1 WHERE id = $2`, [
      encryptJSON(merged),
      clientId,
    ]);
  });

  return oauth2Client;
}
