import { google } from "googleapis";
import type { ResolvedClient } from "../orchestrator/resolveClient";
import { getFreshTokens } from "./googleOAuth";
import { pool } from "../db/pool";
import { decryptJSON } from "../utils/encryption";

async function getOAuthClientForClient(client: ResolvedClient) {
  const { rows } = await pool.query(`SELECT google_oauth_tokens FROM clients WHERE id = $1`, [
    client.id,
  ]);
  const storedTokens = decryptJSON(rows[0]?.google_oauth_tokens);
  if (!storedTokens) return null; // pas encore connecté via /oauth/google/start
  return getFreshTokens(client.id, storedTokens);
}

export async function checkAvailability(
  client: ResolvedClient,
  dateDebut: string,
  dateFin: string
): Promise<string[]> {
  if (!client.googleCalendarId) return [];
  const auth = await getOAuthClientForClient(client);
  
  // R2: Throw error instead of silent return
  if (!auth) {
    throw new Error(
      `Google Calendar OAuth expired for client ${client.id}. ` +
      `Admin must reconnect via /oauth/google/start?client_id=${client.id}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth });

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: new Date(dateDebut).toISOString(),
      timeMax: new Date(dateFin).toISOString(),
      items: [{ id: client.googleCalendarId }],
    },
  });

  const busy = data.calendars?.[client.googleCalendarId]?.busy ?? [];
  return computeFreeSlots(dateDebut, dateFin, busy as { start: string; end: string }[]);
}

/** Génère des créneaux d'1h entre 9h et 18h en excluant les plages occupées. */
function computeFreeSlots(
  dateDebut: string,
  dateFin: string,
  busy: { start: string; end: string }[]
): string[] {
  const slots: string[] = [];
  const start = new Date(dateDebut);
  const end = new Date(dateFin);
  const cursor = new Date(start);

  while (cursor < end) {
    const hour = cursor.getHours();
    if (hour >= 9 && hour < 18) {
      const slotEnd = new Date(cursor.getTime() + 60 * 60 * 1000);
      const overlaps = busy.some(
        (b) => cursor < new Date(b.end) && slotEnd > new Date(b.start)
      );
      if (!overlaps) slots.push(cursor.toISOString());
    }
    cursor.setHours(cursor.getHours() + 1);
  }
  return slots.slice(0, 10);
}

export async function createCalendarEvent(
  client: ResolvedClient,
  datetime: string,
  motif: string
): Promise<{ id: string } | null> {
  if (!client.googleCalendarId) {
    throw new Error(`Aucun calendrier Google configuré pour le client ${client.id}.`);
  }
  const auth = await getOAuthClientForClient(client);
  if (!auth) {
    throw new Error(
      `Google Calendar OAuth absent ou expiré pour le client ${client.id}. ` +
      `Reconnecter via /oauth/google/start?client_id=${client.id}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(datetime);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  const { data } = await calendar.events.insert({
    calendarId: client.googleCalendarId,
    requestBody: {
      summary: motif,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });

  if (!data.id) throw new Error("Google Calendar n'a pas retourné d'identifiant d'événement.");
  return { id: data.id };
}
