-- ============================================================
-- 002_rls.sql — Row-Level Security en défense supplémentaire
-- de l'isolation multi-tenant (optionnel mais recommandé en prod)
-- L'application doit faire: SET app.current_client_id = '<uuid>';
-- au début de chaque requête scopée.
-- ============================================================

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rendez_vous ENABLE ROW LEVEL SECURITY;
ALTER TABLE relances_programmees ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalades ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_contacts ON contacts
  USING (client_id = current_setting('app.current_client_id', true)::uuid);

CREATE POLICY tenant_isolation_rdv ON rendez_vous
  USING (client_id = current_setting('app.current_client_id', true)::uuid);

CREATE POLICY tenant_isolation_relances ON relances_programmees
  USING (client_id = current_setting('app.current_client_id', true)::uuid);

CREATE POLICY tenant_isolation_kb ON knowledge_base_chunks
  USING (client_id = current_setting('app.current_client_id', true)::uuid);

CREATE POLICY tenant_isolation_escalades ON escalades
  USING (client_id = current_setting('app.current_client_id', true)::uuid);

-- conversations est scopée indirectement via contact_id -> contacts.client_id
CREATE POLICY tenant_isolation_conversations ON conversations
  USING (
    contact_id IN (
      SELECT id FROM contacts
      WHERE client_id = current_setting('app.current_client_id', true)::uuid
    )
  );
