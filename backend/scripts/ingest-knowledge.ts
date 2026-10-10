import "dotenv/config";
import fs from "fs";

/**
 * Usage: tsx scripts/ingest-knowledge.ts <client_id> <chemin_fichier.txt>
 * Découpe le fichier en paragraphes (séparés par ligne vide) et les envoie
 * à POST /admin/knowledge-base — scopé par client_id.
 */
async function main() {
  const [clientId, filePath] = process.argv.slice(2);
  if (!clientId || !filePath) {
    console.error("Usage: tsx scripts/ingest-knowledge.ts <client_id> <chemin_fichier.txt>");
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const chunks = content
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((contenu) => ({ contenu, source: filePath }));

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const res = await fetch(`${baseUrl}/admin/knowledge-base`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": process.env.ADMIN_API_KEY ?? "",
    },
    body: JSON.stringify({ client_id: clientId, chunks }),
  });

  const data = await res.json();
  console.log(res.ok ? `${data.inserted} chunks ingérés.` : data);
}

main();
