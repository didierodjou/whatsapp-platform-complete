import { withTenant } from "../db/pool";
import { embed } from "./embed";

export interface KnowledgeChunk {
  contenu: string;
  source: string | null;
  similarity: number;
}

/**
 * Recherche les k chunks les plus pertinents pour une requête,
 * strictement filtrés par client_id (isolation multi-tenant du RAG).
 */
export async function retrieveRelevantChunks(
  clientId: string,
  query: string,
  k = 5
): Promise<KnowledgeChunk[]> {
  const queryEmbedding = await embed(query);

  const { rows } = await withTenant(clientId, (db) =>
    db.query(
      `SELECT contenu, source, 1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_base_chunks
       WHERE client_id = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(queryEmbedding), clientId, k]
    )
  );

  return rows.map((r) => ({
    contenu: r.contenu,
    source: r.source,
    similarity: r.similarity,
  }));
}

export function formatChunksForPrompt(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return "(aucune information pertinente trouvée dans la base de connaissance)";
  return chunks
    .map((c, i) => `[${i + 1}]${c.source ? ` (${c.source})` : ""} ${c.contenu}`)
    .join("\n\n");
}
