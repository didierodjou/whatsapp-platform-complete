/**
 * Anthropic ne fournit pas d'API d'embeddings native — ce module isole
 * le choix du fournisseur pour ne pas coupler le reste du code.
 * Par défaut : Voyage AI (recommandé par Anthropic pour le RAG).
 * Remplace `embed()` par ton fournisseur préféré (OpenAI, Cohere, etc.)
 * sans toucher au reste du système.
 */

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = "voyage-3";
const TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 20_000);
const TENTATIVES = 3;

/**
 * Dimension des vecteurs renvoyés par VOYAGE_MODEL — doit rester alignée sur
 * la colonne `knowledge_base_chunks.embedding` (voir migrations/006).
 * voyage-3 : 1024. En changeant de modèle, migrer la colonne et réindexer.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Un appel réseau unique était fatal : un simple ConnectTimeoutError vers
 * api.voyageai.com faisait échouer tout le traitement du message. On réessaie
 * donc quelques fois avec un backoff court, et on borne explicitement l'attente
 * (le timeout par défaut d'undici est de 10 s sur la seule connexion).
 */
async function callVoyage(input: string | string[]): Promise<number[][]> {
  if (!VOYAGE_API_KEY) {
    throw new Error(
      "VOYAGE_API_KEY manquant dans .env — nécessaire pour générer les embeddings du RAG."
    );
  }

  let derniereErreur: unknown;
  for (let tentative = 1; tentative <= TENTATIVES; tentative++) {
    try {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({ input, model: VOYAGE_MODEL }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const details = await res.text();
        // 4xx (hors 429) : inutile de réessayer, la requête est invalide.
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`Erreur embeddings Voyage AI: ${res.status} ${details}`);
        }
        throw Object.assign(new Error(`Voyage AI ${res.status}: ${details}`), { reessayable: true });
      }

      const data = (await res.json()) as { data: { embedding: number[] }[] };
      return data.data.map((d) => d.embedding);
    } catch (err: any) {
      derniereErreur = err;
      const reessayable = err?.reessayable || err?.name === "TimeoutError" || err?.name === "AbortError" || err?.cause;
      if (!reessayable || tentative === TENTATIVES) break;
      console.warn(
        `Embeddings Voyage AI — tentative ${tentative}/${TENTATIVES} échouée (${err?.message ?? err}), nouvel essai...`
      );
      await new Promise((r) => setTimeout(r, 500 * tentative));
    }
  }
  throw derniereErreur;
}

export async function embed(text: string): Promise<number[]> {
  const [vecteur] = await callVoyage(text);
  return vecteur;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  return callVoyage(texts);
}
