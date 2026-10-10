import { Queue } from "bullmq";
import IORedis from "ioredis";

export const redisConnection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null, // requis par BullMQ
});

/**
 * Deux queues :
 * - "relances"   : traite une relance programmée à échéance
 * - "rappels-rdv": envoie un rappel WhatsApp 24h avant un rendez-vous
 *
 * Contrairement à node-cron (qui tourne dans le process du serveur et se
 * duplique si tu scales à plusieurs instances), BullMQ garantit qu'un job
 * n'est traité qu'une fois même avec plusieurs workers en parallèle.
 */
export const relancesQueue = new Queue("relances", { connection: redisConnection });
export const rappelsQueue = new Queue("rappels-rdv", { connection: redisConnection });

/**
 * Planifie le scan périodique : au lieu d'un cron qui interroge la DB,
 * on pousse un job "scan" répété toutes les heures dans chaque queue.
 * Le worker (voir workers.ts) traite ce job en interrogeant la DB, puis
 * enfile un job individuel par relance/rappel à envoyer.
 */
export async function scheduleRecurringScans() {
  await relancesQueue.add(
    "scan-relances",
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: "scan-relances-recurrent" }
  );
  await rappelsQueue.add(
    "scan-rappels",
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: "scan-rappels-recurrent" }
  );
}
