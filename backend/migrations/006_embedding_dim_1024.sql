-- ============================================================
-- 006_embedding_dim_1024.sql — aligne la dimension des vecteurs
-- sur le modèle d'embeddings réellement utilisé
--
-- `001_init.sql` déclarait VECTOR(1536) (dimension des modèles OpenAI),
-- alors que src/rag/embed.ts appelle Voyage AI `voyage-3`, qui renvoie des
-- vecteurs de 1024 dimensions. Toute insertion dans knowledge_base_chunks
-- échouait donc avec :
--     expected 1536 dimensions, not 1024
--
-- Conséquence observée : la FAQ générique injectée à la création d'un client
-- était systématiquement perdue (l'erreur est avalée par un warning dans
-- admin/routes.ts), et `npm run ingest` échouait — aucun client n'avait le
-- moindre chunk indexé, donc aucune réponse ne s'appuyait sur le RAG.
--
-- Si tu changes de modèle d'embeddings (VOYAGE_MODEL dans src/rag/embed.ts,
-- ou un autre fournisseur), cette dimension doit suivre :
--   voyage-3 / voyage-3.5 / voyage-2 : 1024   |   voyage-3-lite : 512
--   voyage-large-2 / voyage-code-2   : 1536   |   text-embedding-3-small : 1536
-- Réindexation nécessaire après tout changement (les anciens vecteurs
-- deviennent incomparables).
-- ============================================================

-- L'index ivfflat porte sur la colonne : il doit être recréé après l'ALTER.
DROP INDEX IF EXISTS idx_kb_embedding;

ALTER TABLE knowledge_base_chunks
  ALTER COLUMN embedding TYPE vector(1024);

CREATE INDEX idx_kb_embedding ON knowledge_base_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
