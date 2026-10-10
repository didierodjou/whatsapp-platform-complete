-- ============================================================
-- 001_init.sql — schéma multi-tenant du système agent WhatsApp
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- Couche 2 : profils sectoriels, réutilisés entre clients
CREATE TABLE sector_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom_secteur TEXT UNIQUE NOT NULL,
  workflows_actifs JSONB NOT NULL DEFAULT '{}'::jsonb,
  questions_qualification JSONB NOT NULL DEFAULT '[]'::jsonb,
  champs_rdv JSONB NOT NULL DEFAULT '[]'::jsonb,
  ton_par_defaut TEXT NOT NULL DEFAULT '',
  template_system_prompt TEXT NOT NULL,
  declencheurs_relance_defaut JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Couche 3 : une ligne par entreprise cliente
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sector_profile_id UUID NOT NULL REFERENCES sector_profiles(id),
  nom_entreprise TEXT NOT NULL,
  whatsapp_business_number TEXT UNIQUE NOT NULL,
  whatsapp_phone_number_id TEXT, -- ID Meta requis pour envoyer via Graph API
  variables_prompt JSONB NOT NULL DEFAULT '{}'::jsonb,
  hubspot_account_id TEXT,
  google_calendar_id TEXT,
  google_oauth_tokens JSONB,
  statut TEXT NOT NULL DEFAULT 'onboarding'
    CHECK (statut IN ('actif', 'onboarding', 'suspendu')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  whatsapp_number TEXT NOT NULL,
  nom TEXT,
  statut TEXT NOT NULL DEFAULT 'ouvert'
    CHECK (statut IN ('ouvert', 'escalade', 'ferme')),
  opt_in_marketing BOOLEAN NOT NULL DEFAULT true,
  score_lead INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, whatsapp_number)
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  contenu TEXT NOT NULL,
  intention_detectee TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_contact ON conversations(contact_id, timestamp DESC);

CREATE TABLE rendez_vous (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  datetime TIMESTAMPTZ NOT NULL,
  motif TEXT,
  champs_specifiques JSONB DEFAULT '{}'::jsonb, -- ex: {bien, budget} ou {motif, urgence}
  google_event_id TEXT,
  statut TEXT NOT NULL DEFAULT 'confirme'
    CHECK (statut IN ('confirme', 'annule', 'termine')),
  rappel_envoye BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rdv_datetime ON rendez_vous(datetime) WHERE statut = 'confirme';

CREATE TABLE relances_programmees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sujet TEXT NOT NULL,
  date_prevue TIMESTAMPTZ NOT NULL,
  nombre_envoyees INTEGER NOT NULL DEFAULT 0,
  statut TEXT NOT NULL DEFAULT 'en_attente'
    CHECK (statut IN ('en_attente', 'envoyee', 'stoppee', 'terminee')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_relances_a_traiter ON relances_programmees(date_prevue) WHERE statut = 'en_attente';

CREATE TABLE knowledge_base_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contenu TEXT NOT NULL,
  embedding VECTOR(1536),
  source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kb_client ON knowledge_base_chunks(client_id);
CREATE INDEX idx_kb_embedding ON knowledge_base_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE escalades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  resume TEXT NOT NULL,
  urgence TEXT NOT NULL DEFAULT 'normale' CHECK (urgence IN ('basse', 'normale', 'haute')),
  statut TEXT NOT NULL DEFAULT 'ouverte' CHECK (statut IN ('ouverte', 'resolue')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Isolation multi-tenant : toute requête applicative DOIT filtrer par client_id.
-- (Row-Level-Security activable en option — voir migrations/002_rls.sql)
