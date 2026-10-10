import type { ResolvedClient } from "../orchestrator/resolveClient";

/**
 * Envoi d'email via Resend (resend.com) — API simple, un seul appel HTTP,
 * pas de SDK SMTP à configurer. Remplaçable par SendGrid en changeant
 * uniquement sendEscalationEmail() ci-dessous.
 */
async function sendEscalationEmail(subject: string, html: string) {
  const to = process.env.ESCALATION_EMAIL_TO;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ESCALATION_EMAIL_FROM ?? "agent@votre-domaine.com";

  if (!to || !apiKey) return false;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    console.error(`Échec envoi email d'escalade: ${res.status} ${await res.text()}`);
    return false;
  }
  return true;
}

export async function notifyEscalation(
  client: ResolvedClient,
  params: { resume: string; urgence: string }
) {
  const emoji = params.urgence === "haute" ? "🔴" : params.urgence === "normale" ? "🟠" : "⚪";
  const slackMessage = `${emoji} Escalade — ${client.nomEntreprise}\nUrgence: ${params.urgence}\n${params.resume}`;

  let slackOk = false;
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: slackMessage }),
      });
      slackOk = res.ok;
    } catch (err) {
      console.error("Échec notification Slack:", err);
    }
  }

  const emailOk = await sendEscalationEmail(
    `${emoji} Escalade ${client.nomEntreprise} — urgence ${params.urgence}`,
    `<p><strong>Client :</strong> ${client.nomEntreprise}</p>
     <p><strong>Urgence :</strong> ${params.urgence}</p>
     <p><strong>Résumé :</strong> ${params.resume}</p>`
  );

  if (!slackOk && !emailOk) {
    console.warn(
      "Aucun canal d'escalade n'a fonctionné (vérifie SLACK_WEBHOOK_URL / RESEND_API_KEY + ESCALATION_EMAIL_TO)."
    );
  }
}
