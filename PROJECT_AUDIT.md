# Audit Complet — Agent WhatsApp Platform

**Date**: 2026-08-23  
**Statut du projet**: ~85% complet, prêt pour finalisation et déploiement  
**Basé sur**: Prompt de Build détaillé (section 1-8)

---

## 1. Vue Générale — Ce Qui Est Implémenté ✅

### Architecture Multi-Tenant & Sécurité
- ✅ Table `clients` + `sector_profiles` (séparation core/profil/variables)
- ✅ Résolution dynamique du client via numéro WhatsApp Business
- ✅ RLS (Row-Level Security) en place dans migration 002
- ✅ Helper `withTenant()` pour isolation des requêtes
- ✅ Chiffrement des tokens sensibles (Google OAuth, HubSpot)
- ✅ Middleware `requireAdminKey` sur tous les endpoints admin

### Webhook WhatsApp
- ✅ Vérification signature Meta (`X-Hub-Signature-256`)
- ✅ Parsing des messages entrants (texte uniquement actuellement)
- ✅ Envoi de messages sortants via Graph API (texte + templates)
- ✅ Réponse rapide (20s requirement) + traitement asynchrone en arrière-plan

### LLM & Tool Use (Claude)
- ✅ Intégration Anthropic SDK avec modèle `claude-sonnet-4-6`
- ✅ Système prompt dynamique (core + profil sectoriel + variables client)
- ✅ Tool use avec 5 tools: `check_calendar_availability`, `book_appointment`, `create_lead`, `escalate_to_human`, `unsubscribe_contact`
- ✅ Boucle de tool execution (MAX_TOOL_ROUNDS = 4)
- ✅ Filtrage des tools par secteur (workflows_actifs)
- ✅ Historique de conversation (limité à fenêtre)

### RAG (Base de Connaissance)
- ✅ Table `knowledge_base_chunks` avec embeddings vectoriels (pgvector)
- ✅ Ingestion via `POST /admin/knowledge-base` (chunks + sources)
- ✅ Récupération sémantique (top-k similaires)
- ✅ FAQ générique pré-générée par secteur
- ✅ Isolation par `client_id`

### Intégrations Externes
- ✅ **Google Calendar**: OAuth2 flow, check availability, create events
- ✅ **HubSpot**: Push leads avec scoring, propriétés personnalisées par secteur
- ✅ **Escalation**: Notifications Slack + email Resend
- ✅ **WhatsApp**: Templates approuvés, envoi texte + templates

### Workflows (Tools & Handlers)
- ✅ **SAV** (Support client): réponses via RAG
- ✅ **Qualification de leads**: `create_lead` avec scoring 0-100
- ✅ **Prise de rendez-vous**: vérification dispo + booking + reminder
- ✅ **Escalade humaine**: notification + statut `escalade` du contact
- ✅ **Unsubscribe**: opt-out marketing avec `unsubscribe_contact`
- ✅ **Relances programmées**: scan toutes les heures + max 2 tentatives

### Scheduler & Background Jobs
- ✅ BullMQ + Redis pour queue de jobs
- ✅ Worker séparé pour traiter relances + rappels RDV
- ✅ Recurring scans (une fois par heure)
- ✅ Idempotence (un job = une seule exécution)

### Admin Console
- ✅ Next.js 14 frontend avec React 18
- ✅ Dashboard: client list + search
- ✅ Wizard: multi-step création client
- ✅ Duplicate client: clone config précédente
- ✅ Next.js API routes masquent `BACKEND_ADMIN_KEY` au navigateur

### Scripts & Onboarding
- ✅ `npm run migrate` (SQL migrations)
- ✅ `npm run seed` (5 profils sectoriels pré-remplis)
- ✅ `npm run onboard` (CLI interactif)
- ✅ `npm run ingest` (upload + vectorisation documents)

### Base de Données
- ✅ Migrations 001 (tables), 002 (RLS), 003 (chiffrement)
- ✅ Seed SQL avec 5 profils sectoriels: restaurant, boutique, immobilier, sport, dentaire
- ✅ Toutes les tables portent `client_id` pour isolation

### Tests
- ✅ `encryption.test.ts` (chiffrement/déchiffrement)
- ✅ `resolveClient.test.ts` (résolution et prompt builder)
- ✅ `whatsapp.test.ts` (parsing webhook)
- ✅ Framework: Vitest + mock de la DB

---

## 2. Gaps & Items Manquants ⚠️

### Critical Path Issues

| # | Item | Priorité | Effort | Status |
|----|------|----------|--------|--------|
| 1 | Test d'intégration E2E (webhook → Claude → tool → DB) | **HAUTE** | 4h | À faire |
| 2 | Documentation de déploiement (Railway/Docker) | **HAUTE** | 2h | Partielle |
| 3 | Vérification des URLs de callback (Google OAuth, Meta webhook) | **HAUTE** | 0.5h | À valider |
| 4 | Gestion des erreurs et retry logic pour outils externes | **HAUTE** | 3h | Basique |
| 5 | Test load/stress sur scheduler et worker | **MOYENNE** | 3h | À faire |
| 6 | Logs structurés et observabilité (format JSON) | **MOYENNE** | 2h | À faire |
| 7 | Validation & nettoyage des inputs (injection RAG, SQL) | **MOYENNE** | 2h | Basique |
| 8 | Limite de rate limiting configurable | **BASSE** | 0.5h | Codée en dur (120/min) |

### Détails par Domaine

#### A. Webhook & Parsing (WebhookRouter)
**État**: 80% — Texte supporté, autres types partiels
- ✅ Texte : OK
- ✅ Vérification signature Meta : OK
- ⚠️ Boutons interactifs (quick_reply): parsés mais **non exécutés** (reçus comme texte)
- ⚠️ Listes: non gérées
- ⚠️ Images: reçues mais pas de traitement (accusé réception uniquement)
- ⚠️ Status (read, delivered): non loggées

**Action**: Pour le MVP, le traitement "texte uniquement" est acceptable. Ajouter les autres types avant scale.

---

#### B. Google Calendar OAuth
**État**: 85% — Flow OK, edge cases à couvrir
- ✅ Initiation OAuth: `GET /oauth/google/start`
- ✅ Callback: `GET /oauth/google/callback`
- ✅ Stockage tokens chiffrés
- ✅ Refresh tokens expirés
- ⚠️ **Pas de validation** de `GOOGLE_REDIRECT_URI` vs config Meta
- ⚠️ **Pas de test** du flow OAuth complet
- ⚠️ **Pas de fallback** si refresh token invalide (30j d'inactivité)

**Action**: Ajouter un test d'intégration OAuth + vérifier URL dans `.env`.

---

#### C. HubSpot Push
**État**: 75% — Basique, props personnalisées non mappées
- ✅ Création contact
- ✅ Push avec scoring
- ⚠️ **Pas de mappage des propriétés** par secteur (les props spécifiques "besoin", "budget", etc. doivent être créées manuellement dans HubSpot)
- ⚠️ **Pas de validation** si `hubspot_account_id` valide
- ⚠️ **Pas de retry** en cas d'erreur 429 (rate limit HubSpot)

**Action**: Documenter étapes de setup HubSpot (créer propriétés personnalisées) + ajouter exponential backoff.

---

#### D. RAG & Embeddings (Voyage API)
**État**: 90% — Fonctionnel, mais dépend d'une clé externe
- ✅ Ingestion chunks
- ✅ Recherche sémantique (pgvector)
- ✅ FAQ générique auto-générée par secteur
- ⚠️ **VOYAGE_API_KEY manquante** = embeddings non générés (logs avertis, FAQs ignorées)
- ⚠️ **Pas de batch processing** efficace (embedBatch() existe mais pas d'optimisation)
- ⚠️ **Pas de gestion de la limite** de tokens par document

**Action**: Tester intégration Voyage API en dev + documenter alternative (OpenAI embeddings).

---

#### E. Scheduler & Worker
**État**: 90% — Robuste, mais monitoring manquant
- ✅ BullMQ + Redis OK
- ✅ Idempotence + retry OK
- ✅ Scan relances + rappels OK
- ⚠️ **Pas de monitoring** des jobs stuck ou dead-letter queue
- ⚠️ **Pas de dashboard** BullMQ pour inspecter queue en live
- ⚠️ **Pas de limite** de concurrence configurable par environment
- ⚠️ **Pas de circuit breaker** si Redis down

**Action**: Ajouter simple health check + logs queue depth.

---

#### F. Escalation & Notifications
**État**: 80% — Double notification (Slack + Email) OK, mais filtrage faible
- ✅ Slack webhook
- ✅ Resend email
- ⚠️ **Pas de vérification** que SLACK_WEBHOOK_URL ou RESEND_API_KEY sont valides avant d'essayer
- ⚠️ **Pas de template d'email** riche (HTML simple)
- ⚠️ **Pas de lien** vers la conversation dans le dashboard humain

**Action**: Ajouter lien vers `admin-console/clients/:clientId` dans notification.

---

#### G. Admin Routes & Sécurité
**État**: 90% — Auth basique OK, mais à durcir
- ✅ ADMIN_API_KEY requis sur tous les endpoints `/admin/*`
- ⚠️ **Pas de rate limiting spécifique** aux endpoints admin (juste 120/min global)
- ⚠️ **Pas de audit log** des modifications admin (qui a créé quel client, quand)
- ⚠️ **Pas de soft delete** (DELETE immédiat pour contacts = perte RGPD log)

**Action**: Ajouter audit_log table + SOFT_DELETE (marquage `deleted_at`).

---

#### H. Tests & Coverage
**État**: 50% — Trop peu, gaps critiques
- ✅ 3 test files présents
- ⚠️ **Pas de test** de la boucle complète: webhook → Claude → tool → DB
- ⚠️ **Pas de test** du `withTenant()` avec plusieurs clients
- ⚠️ **Pas de test** de converseWithClaude (mock Anthropic manquant)
- ⚠️ **Pas de test** du worker BullMQ
- ⚠️ **Pas de test** du DAG sectoriel (profil + variables)

**Action**: Ajouter `npm run test:e2e` avec cas: "réserver un RDV" end-to-end.

---

#### I. Frontend Admin Console
**État**: 80% — Fonctionnel en lecture, édition partielle
- ✅ Dashboard: affiche clients
- ✅ Wizard: crée clients
- ✅ Duplicate: clone config
- ⚠️ **Pas d'éditeur** pour variables_prompt (édition inline)
- ⚠️ **Pas de lien** vers ingest knowledge pour ce client
- ⚠️ **Pas de bouton** "test webhook" ou "simuler message"

**Action**: Ajouter formulaire d'édition variables + test simulator (après MVP).

---

#### J. Documentation
**État**: 40% — Beaucoup de détails manquent
- ✅ AGENTS.md complet
- ✅ backend/README.md francisé
- ⚠️ **Pas de guide** "Déployer sur Railway en 5 minutes"
- ⚠️ **Pas de guide** "Connecter un nouveau client" pas-à-pas
- ⚠️ **Pas de guide** "Tester le webhook en local" (ngrok)
- ⚠️ **Pas de troubleshooting guide** complet (logs, erreurs fréquentes)

**Action**: Créer DEPLOYMENT.md + CLIENT_ONBOARDING.md + LOCAL_TESTING.md.

---

#### K. Erreurs & Edge Cases
**État**: 60% — Basique, manque couverture
- ✅ Signature Meta rejetée → 401 OK
- ✅ Client introuvable → message ignoré OK
- ⚠️ **Pas de gestion**: Claude timeout (relay message human?)
- ⚠️ **Pas de gestion**: Calendar API down (fallback message?)
- ⚠️ **Pas de gestion**: Database connection lost (retry, queue?)
- ⚠️ **Pas de gestion**: RLS violation edge case

**Action**: Ajouter fallback messages + circuit breaker pattern.

---

## 3. Sommaire des Fichiers Clés

| Fichier | Rôle | État | Commentaire |
|---------|------|------|-----------|
| `src/server.ts` | Express setup + routes | 95% | Rate limiting codé en dur |
| `src/orchestrator/handleIncomingMessage.ts` | Message entry point | 100% | Prêt |
| `src/orchestrator/resolveClient.ts` | Client lookup + prompt builder | 100% | Prêt |
| `src/llm/converse.ts` | Claude loop + tool filtering | 95% | Gestion erreur basique |
| `src/llm/executeTool.ts` | Tool routing + execution | 90% | Pas de validation input |
| `src/rag/retrieve.ts` | Semantic search | 95% | Dépend Voyage API |
| `src/integrations/calendar.ts` | Google Calendar | 85% | Pas de fallback |
| `src/integrations/hubspot.ts` | HubSpot push | 75% | Pas de retry |
| `src/integrations/whatsapp.ts` | Meta Graph API | 90% | Templates partiels |
| `src/webhook/whatsappWebhook.ts` | Webhook receiver | 80% | Texte uniquement |
| `src/scheduler/worker.ts` | Background jobs | 90% | Pas de monitoring |
| `src/admin/routes.ts` | Admin endpoints | 90% | Pas de audit log |
| `admin-console/app/page.tsx` | Dashboard | 80% | Pas d'éditeur variables |
| `admin-console/components/Wizard.tsx` | Client creation form | 85% | UX peut s'améliorer |
| `.env.example` | Env vars template | 100% | Complet |
| `migrations/001_init.sql` | Schema | 100% | Complet |
| `migrations/002_rls.sql` | RLS policies | 100% | Complet |
| `migrations/003_encrypt_sensitive_fields.sql` | Chiffrement | 100% | Complet |
| `seeds/sector_profiles.sql` | Profils sectoriels | 100% | 5 secteurs OK |

---

## 4. Checklist de Finalisation (Avant Déploiement)

### Phase 1: Stabilité (3h)
- [ ] Test E2E: webhook → Claude → tool → DB pour un cas simple (SAV)
- [ ] Test: RLS isolation (query client A ne voit pas données client B)
- [ ] Vérifier ENCRYPTION_KEY valide (64-char hex)
- [ ] Vérifier rate limiting (120 req/min) = acceptable
- [ ] Tester migration + seed sur base vierge

### Phase 2: Intégrations Externes (2h)
- [ ] Valider `.env` avec vraies clés: ANTHROPIC_API_KEY, Meta tokens, Google OAuth
- [ ] Tester webhook Meta real (pas en local)
- [ ] Tester Google Calendar OAuth flow
- [ ] Tester HubSpot push avec sample lead
- [ ] Tester Slack/email escalation (optionnel pour MVP)

### Phase 3: Déploiement (2h)
- [ ] Créer Railway project
- [ ] Configurer PostgreSQL managé (+ enable pgvector)
- [ ] Configurer Redis managé
- [ ] Déployer backend (`npm run migrate` en release command)
- [ ] Déployer worker (service séparé ou job recurring)
- [ ] Déployer admin-console
- [ ] Valider webhooks pointent vers Railway domain

### Phase 4: Documentation (2h)
- [ ] Créer DEPLOYMENT.md (Railway steps)
- [ ] Créer LOCAL_TESTING.md (ngrok + webhook mock)
- [ ] Créer CLIENT_ONBOARDING.md (pas-à-pas nouveau client)
- [ ] Ajouter troubleshooting guide au README

### Phase 5: Scaling (Après MVP)
- [ ] Ajouter monitoring BullMQ (queue depth, job latency)
- [ ] Configurer alertes (Slack/email si queue stuck)
- [ ] Ajouter audit log table
- [ ] Ajouter éditeur variables dans admin console
- [ ] Tester avec 10+ clients simultanés
- [ ] Profiler + optimiser requêtes lentes

---

## 5. Détails des Défauts de Sécurité à Corriger ⚠️

### Critique

1. **Pas d'audit log des modifications admin**
   - Risque: Admin supprime un client par erreur, pas de trace
   - Fix: Ajouter `audit_log` table, logger `(user_id, action, resource, timestamp)`

2. **SOFT_DELETE manquant** (RGPD)
   - Risque: DELETE contact immédiatement, pas de récupération
   - Fix: Ajouter colonne `deleted_at`, soft-delete par défaut

3. **Pas de validation input sur RAG chunks**
   - Risque: Injection SQL via contenu (bien limité par paramètre, mais)
   - Fix: Ajouter whitelist charset, limiter taille

### Moyen

4. **Pas de rate limiting par client**
   - Risque: Un client peut spammer messages
   - Fix: Ajouter rate limit par `client_id` (100 msg/heure?)

5. **ADMIN_API_KEY pas rotatable**
   - Risque: Clé compromise = accès toutes les données
   - Fix: Ajouter key versioning + expiry (optionnel pour MVP)

### Bas

6. **Logs contiennent potentiellement données sensibles**
   - Risque: Numéro WhatsApp en clair dans logs stdout
   - Fix: Masquer données sensibles en logs (optionnel)

---

## 6. Recommandations de Déploiement

### Architecture Proposée pour Railway

```
Backend API Service
├── Environment: Node.js 20
├── Cmd: npm run dev
└── Scale: 2 instances (load balance)

Worker Service (separate)
├── Environment: Node.js 20
├── Cmd: npm run worker
└── Scale: 1 instance (ou 2 si queue huge)

Admin Console Service
├── Environment: Node.js 18 (Next.js)
├── Cmd: npm run build && npm start
└── Scale: 1 instance

PostgreSQL (Railway managed)
├── Version: 15+
├── Extension: pgvector enable
└── Backup: Daily

Redis (Railway managed)
├── Version: 7+
└── Backup: None (queue, OK to lose)
```

### Env Vars à Set en Production

```
PORT=3000
NODE_ENV=production
BASE_URL=https://your-domain.railway.app
DATABASE_URL=postgres://[Railway PostgreSQL]
REDIS_URL=redis://[Railway Redis]
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
WHATSAPP_VERIFY_TOKEN=[Meta dashboard]
WHATSAPP_APP_SECRET=[Meta dashboard]
WHATSAPP_ACCESS_TOKEN=[Meta token endpoint]
GOOGLE_CLIENT_ID=[Google Cloud Console]
GOOGLE_CLIENT_SECRET=[Google Cloud Console]
GOOGLE_REDIRECT_URI=https://your-domain.railway.app/oauth/google/callback
HUBSPOT_ACCESS_TOKEN=[HubSpot app]
ADMIN_API_KEY=[long random string, change from dev]
ENCRYPTION_KEY=[64-char hex, generate: node -e "..."]
VOYAGE_API_KEY=[Voyage AI, optional]
SLACK_WEBHOOK_URL=[optional for escalation]
RESEND_API_KEY=[optional for escalation]
```

---

## 7. Palier de Livraison Recommandé

### MVP (v1.0) — Prêt Maintenant
- ✅ Webhook reception + parsing (texte)
- ✅ Claude avec RAG
- ✅ Tools: calendar (check + book), leads
- ✅ Admin console: client CRUD
- ✅ Scheduler: relances + rappels
- ✅ RLS + chiffrement
- ✅ 5 profils sectoriels pré-remplis

**Timeline pour production**: 1-2 semaines (finalisation + tests + deployment)

### v1.1 (2 semaines après MVP)
- Amélioration webhook: buttons, listes, images
- Audit log + soft delete
- Admin console: variable editor
- Monitoring BullMQ dashboard
- Improved error handling + circuit breaker

### v1.2 (1 mois après MVP)
- Multi-language support (EN, ES, DE)
- Template builder dans admin console
- Integrations: Slack commands, Typeform, Zapier
- Analytics dashboard

---

## 8. Score de Complétude par Domaine

| Domaine | Complétude | Impact MVP |
|---------|------------|-----------|
| Architecture multi-tenant | 95% | Critique ✅ |
| Webhook reception | 80% | Critique ⚠️ |
| LLM + Tool Use | 95% | Critique ✅ |
| RAG | 90% | Important ✅ |
| Calendar integration | 85% | Important ⚠️ |
| Admin console | 80% | Important ⚠️ |
| Scheduler | 90% | Important ✅ |
| Tests | 50% | Important ⚠️ |
| Documentation | 40% | Important ⚠️ |
| **Moyenne Globale** | **~80%** | **Prêt pour MVP** ✅ |

---

## 9. Prochaines Étapes Immédiates (48h)

1. **Test E2E complet** (webhook → response)
   - File: `tests/e2e.integration.test.ts`
   - Case: Receive "Je veux une table pour 4" → book appointment

2. **Vérifier URLs de callback**
   - [ ] GOOGLE_REDIRECT_URI dans `.env` vs Google Cloud Console
   - [ ] Webhook URL dans Meta dashboard pointe vers prodution domain

3. **Documenter deployment sur Railway**
   - File: `DEPLOYMENT.md`
   - Include: Screenshots, env vars checklist, post-deploy tests

4. **Setup monitoring basique**
   - Logs structurés (JSON format)
   - Queue depth alert

5. **Onboard un vrai client en test**
   - Use `npm run onboard` CLI
   - Test full flow: WhatsApp → message → Claude → calendar

---

**Status Final**: Le projet est **structurellement solide et prêt pour MVP**. Les gaps restants sont principalement:
- Tests & documentation (non-bloquants pour déploiement)
- Edge cases & monitoring (post-MVP OK)
- UI/UX minor improvements (après v1.0)

**Recommandation**: Déployer MVP maintenant, itérer sur v1.1 en production avec 2-3 clients pilots.
