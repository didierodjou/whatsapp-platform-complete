/**
 * Appelle le backend Express (whatsapp-agent) avec la clé admin.
 * N'est importé QUE depuis des API routes Next.js (server-side) —
 * BACKEND_ADMIN_KEY ne doit jamais atteindre le bundle client.
 */
export async function backendFetch(path: string, init?: RequestInit) {
  const baseUrl = process.env.BACKEND_URL;
  const adminKey = process.env.BACKEND_ADMIN_KEY;

  if (!baseUrl || !adminKey) {
    throw new Error(
      "BACKEND_URL ou BACKEND_ADMIN_KEY manquant — configure le .env de admin-console."
    );
  }

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  return res;
}
