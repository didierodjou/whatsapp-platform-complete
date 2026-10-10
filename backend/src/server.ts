import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { whatsappWebhookRouter } from "./webhook/whatsappWebhook";
import { adminRouter } from "./admin/routes";
import { googleOAuthRouter } from "./integrations/googleOAuth";
import { scheduleRecurringScans } from "./scheduler/queues";
import { errorHandler } from "./utils/asyncRoute";

const app = express();

app.use(helmet());

// On garde le rawBody pour vérifier la signature Meta (X-Hub-Signature-256)
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Rate limiting basique sur les endpoints publics
const requestCounts = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + 60_000 });
  } else {
    entry.count++;
    if (entry.count > 120) return res.status(429).json({ error: "Trop de requêtes." });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ statut: "ok" }));

app.use(whatsappWebhookRouter);
app.use(googleOAuthRouter);
app.use("/admin", adminRouter);

// Doit rester APRÈS les routes : traduit les erreurs des handlers async en
// réponses HTTP (409 sur doublon, 400 sur donnée invalide, 500 sinon) au lieu
// de laisser Node terminer le processus sur un unhandledRejection.
app.use(errorHandler);

// Filet de dernier recours : un rejet non rattrapé ailleurs (worker BullMQ,
// tâche de fond du webhook) est journalisé, il ne tue plus le serveur.
process.on("unhandledRejection", (reason) => {
  console.error("Rejet de promesse non géré (serveur maintenu en vie):", reason);
});

const PORT = process.env.PORT ?? 3000;
const server = app.listen(PORT, async () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  await scheduleRecurringScans();
  console.log(
    "Scans récurrents planifiés dans Redis (relances, rappels RDV). " +
      "Lance `npm run worker` (process séparé) pour qu'ils soient réellement traités."
  );
});

// Sans écouteur 'error', Node relance l'erreur brute : une pile d'appels de
// 20 lignes pour dire « un serveur tourne déjà ». On explique quoi faire.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n❌ Le port ${PORT} est déjà utilisé — un serveur tourne probablement dans un autre terminal.\n\n` +
        `   Vérifier qui l'occupe :\n` +
        `     PowerShell : Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object OwningProcess\n\n` +
        `   Puis, au choix :\n` +
        `     • réutiliser ce serveur (c'est lui qui affiche les logs des messages entrants) ;\n` +
        `     • l'arrêter — avec « tsx watch », tuer le processus PARENT, sinon il relance aussitôt un enfant ;\n` +
        `     • démarrer sur un autre port : $env:PORT=3002; npm run dev\n`
    );
    process.exit(1);
  }
  console.error("Erreur du serveur HTTP:", err);
  process.exit(1);
});
