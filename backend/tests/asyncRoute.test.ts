import { describe, it, expect, vi } from "vitest";
import { asyncRoute, errorHandler } from "../src/utils/asyncRoute";

function fakeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe("asyncRoute — un handler async qui échoue ne doit pas tuer le processus", () => {
  it("transmet le rejet à next() au lieu de le laisser remonter", async () => {
    const boom = new Error("échec base");
    const next = vi.fn();

    asyncRoute(async () => {
      throw boom;
    })({} as any, fakeRes(), next);

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(boom));
  });

  it("laisse passer un handler qui réussit", async () => {
    const next = vi.fn();
    const res = fakeRes();

    asyncRoute(async (_req, r: any) => r.status(200).json({ ok: true }))({} as any, res, next);

    await vi.waitFor(() => expect(res.json).toHaveBeenCalledWith({ ok: true }));
    expect(next).not.toHaveBeenCalled();
  });
});

describe("errorHandler — traduction des erreurs Postgres", () => {
  it("409 sur violation d'unicité (ex. numéro WhatsApp déjà pris)", () => {
    const res = fakeRes();
    errorHandler(
      { code: "23505", detail: "Key (whatsapp_business_number)=(+1 555) already exists." },
      {} as any,
      res,
      vi.fn()
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toMatch(/existe déjà/);
  });

  it("400 sur identifiant mal formé", () => {
    const res = fakeRes();
    errorHandler({ code: "22P02" }, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("500 sur erreur inconnue, sans divulguer le détail interne", () => {
    const res = fakeRes();
    errorHandler(new Error("connexion perdue"), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Erreur interne du serveur." });
  });
});
