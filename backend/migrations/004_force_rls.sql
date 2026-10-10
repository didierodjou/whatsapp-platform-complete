-- ============================================================
-- 004_force_rls.sql — rend la RLS de 002 réellement effective
--
-- Problème corrigé : ENABLE ROW LEVEL SECURITY (migration 002) ne
-- s'applique PAS au propriétaire des tables. Si l'application se connecte
-- avec le rôle propriétaire (cas par défaut : un seul utilisateur Postgres
-- pour les migrations et pour l'app), toutes les policies de 002 étaient
-- silencieusement contournées — l'isolation multi-tenant ne reposait donc
-- que sur les filtres `client_id` applicatifs.
--
-- FORCE ROW LEVEL SECURITY applique les policies au propriétaire aussi.
-- (Un superutilisateur, ou un rôle BYPASSRLS, contourne toujours la RLS :
-- en production, l'app DOIT se connecter avec un rôle non-superutilisateur
-- — voir la section « Rôle applicatif Postgres » de DEPLOYMENT.md.)
--
-- Deuxième volet : les routes /admin et le worker BullMQ ont besoin de
-- requêtes légitimement cross-tenant (retrouver le client propriétaire
-- d'un contact / d'une relance avant de pouvoir scoper). On leur donne une
-- porte de sortie explicite et auditable — `app.admin_mode = 'on'`, posée
-- uniquement par le helper withAdmin() de src/db/pool.ts — plutôt que de
-- laisser la RLS inerte pour tout le monde.
-- ============================================================

ALTER TABLE contacts               FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations          FORCE ROW LEVEL SECURITY;
ALTER TABLE rendez_vous            FORCE ROW LEVEL SECURITY;
ALTER TABLE relances_programmees   FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_chunks  FORCE ROW LEVEL SECURITY;
ALTER TABLE escalades              FORCE ROW LEVEL SECURITY;

-- Policies permissives supplémentaires : elles s'additionnent (OR) à celles
-- de 002. Sans `SET LOCAL app.admin_mode`, current_setting renvoie NULL et
-- la policy est donc fausse — aucun élargissement d'accès par défaut.
CREATE POLICY admin_mode_contacts ON contacts
  USING (current_setting('app.admin_mode', true) = 'on');

CREATE POLICY admin_mode_conversations ON conversations
  USING (current_setting('app.admin_mode', true) = 'on');

CREATE POLICY admin_mode_rdv ON rendez_vous
  USING (current_setting('app.admin_mode', true) = 'on');

CREATE POLICY admin_mode_relances ON relances_programmees
  USING (current_setting('app.admin_mode', true) = 'on');

CREATE POLICY admin_mode_kb ON knowledge_base_chunks
  USING (current_setting('app.admin_mode', true) = 'on');

CREATE POLICY admin_mode_escalades ON escalades
  USING (current_setting('app.admin_mode', true) = 'on');
