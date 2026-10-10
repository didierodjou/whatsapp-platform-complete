import type { NextFunction, Request, Response } from "express";

/**
 * Express 4 ne rattrape pas les rejets de promesse des handlers `async` :
 * l'erreur remonte en `unhandledRejection`, que Node (>= 15) traite en
 * terminant le processus. Une simple requête admin invalide — par exemple un
 * numéro WhatsApp déjà pris, qui viole la contrainte UNIQUE — suffisait donc
 * à mettre toute l'API à terre.
 *
 * `asyncRoute` renvoie l'erreur à Express (next), qui la confie au
 * gestionnaire ci-dessous au lieu de laisser le processus mourir.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Codes d'erreur Postgres traduits en réponses HTTP explicites. */
const PG_ERRORS: Record<string, { status: number; message: string }> = {
  "23505": { status: 409, message: "Cette valeur existe déjà (contrainte d'unicité)." },
  "23503": { status: 400, message: "Référence inexistante (clé étrangère)." },
  "23502": { status: 400, message: "Champ obligatoire manquant." },
  "22P02": { status: 400, message: "Format de valeur invalide (identifiant attendu)." },
};

/**
 * Gestionnaire d'erreurs global — à monter APRÈS toutes les routes.
 * Renvoie un statut exploitable au client et, surtout, garde le serveur en vie.
 */
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const known = err?.code ? PG_ERRORS[err.code] : undefined;

  if (known) {
    console.error(`Erreur ${err.code} (${known.status}):`, err.detail ?? err.message);
    return res.status(known.status).json({ error: known.message, detail: err.detail ?? null });
  }

  console.error("Erreur non gérée sur une route:", err);
  res.status(500).json({ error: "Erreur interne du serveur." });
}
