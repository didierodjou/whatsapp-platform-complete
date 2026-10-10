-- ============================================================
-- 005_rls_nullif.sql — corrige un cast qui fait échouer les requêtes
-- sur une connexion recyclée du pool
--
-- Les policies de 002 castent directement :
--     current_setting('app.current_client_id', true)::uuid
--
-- current_setting(..., missing_ok => true) renvoie NULL tant que le
-- paramètre n'a JAMAIS été posé sur la session — mais après une
-- transaction withTenant (SET LOCAL), le paramètre existe et retombe à la
-- chaîne VIDE, pas à NULL. Sur une connexion réutilisée par le pool pg,
-- la policy évalue alors ''::uuid et lève :
--     invalid input syntax for type uuid: ""
-- ce qui casse toute requête ultérieure sur ces tables (y compris les
-- lookups admin), au lieu de simplement ne renvoyer aucune ligne.
--
-- nullif(..., '') ramène la chaîne vide à NULL → la comparaison est
-- fausse, aucune ligne n'est visible : le comportement voulu.
-- ============================================================

DROP POLICY IF EXISTS tenant_isolation_contacts ON contacts;
CREATE POLICY tenant_isolation_contacts ON contacts
  USING (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_rdv ON rendez_vous;
CREATE POLICY tenant_isolation_rdv ON rendez_vous
  USING (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_relances ON relances_programmees;
CREATE POLICY tenant_isolation_relances ON relances_programmees
  USING (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_kb ON knowledge_base_chunks;
CREATE POLICY tenant_isolation_kb ON knowledge_base_chunks
  USING (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_escalades ON escalades;
CREATE POLICY tenant_isolation_escalades ON escalades
  USING (client_id = nullif(current_setting('app.current_client_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_conversations ON conversations;
CREATE POLICY tenant_isolation_conversations ON conversations
  USING (
    contact_id IN (
      SELECT id FROM contacts
      WHERE client_id = nullif(current_setting('app.current_client_id', true), '')::uuid
    )
  );
