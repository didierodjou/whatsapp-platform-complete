import { Request, Response, NextFunction } from "express";

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Clé admin invalide ou manquante." });
  }
  next();
}
