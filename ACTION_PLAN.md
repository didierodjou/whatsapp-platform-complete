# Plan d'Action Finalisation — WhatsApp Agent Platform

**Objectif**: Préparer le projet pour déploiement production MVP en 48-72h  
**Statut**: ~85% complet, 15% de finition critique  
**Public**: Équipe de développement, DevOps, QA

---

## 🎯 Priorités Critiques (24-48h)

### Tier 1: Blockers Absolus

#### 1.1 Test E2E: Webhook → Claude → Tool → DB
**Pourquoi**: Valider la chaîne complète avant production  
**Fichier**: `tests/e2e.integration.test.ts` (NEW)  
**Cas de test**:
```typescript
// Case 1: SAV simple
Input: "Quels sont vos horaires ?"
Expected: Response from RAG KB

// Case 2: Book appointment (restaurant)
Input: "Je voudrais une table pour 4 personnes ce soir"
Expected: 
  - Claude appelle check_calendar_availability
  - Claude appelle book_appointment
  - Événement créé en Google Calendar
  - RDV enregistré en DB
  - Réponse confirmation envoyée

// Case 3: Lead qualification (immobilier)
Input: "Je cherche un 3 pièces, budget 400k, zone Paris 6e"
Expected:
  - Claude appelle create_lead avec score >= 60
  - Contact marqué comme lead en DB
  - HubSpot notification (si connecté)
  - Escalation email si score > 70
```
**Effort**: 4h  
**Bloqué par**: Rien  
**Responsable**: QA/Dev lead  

---

#### 1.2 Vérifier & Documenter URLs de Callback Externally Facing
**Pourquoi**: Webhook Meta et Google OAuth dépendent d'URLs exactes  
**Checklist**:
```
☐ Google Cloud Console: 
  - Authorized redirect URIs contient exactement:
    https://[votre-domain].railway.app/oauth/google/callback
  
☐ Meta Dashboard (WhatsApp):
  - Webhook URL: https://[votre-domain].railway.app/webhook
  - Callback Verify Token: Correspond à WHATSAPP_VERIFY_TOKEN en .env
  
☐ .env.local (admin-console):
  - BACKEND_URL=https://[votre-domain].railway.app (HTTPS, pas localhost)
  
☐ Test validation:
  npm run onboard  [choisir "restaurant"]
  → Voir que client_id est créé ✅
  → Envoyer message WhatsApp au numéro de test
  → Vérifier dans logs que webhook est reçu
```
**Effort**: 0.5h  
**Responsable**: DevOps / Pas Didier  

---

#### 1.3 Tester la Migration + Seed sur Base Vierge
**Pourquoi**: Garantir qu'un nouveau déploiement Railway réussit  
**Étapes**:
```bash
# 1. Backup .env en production
cp .env .env.backup

# 2. Vider la DB (LOCAL ONLY)
psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 3. Relancer migrate + seed
npm run migrate
npm run seed

# 4. Vérifier que 5 profils sectoriels sont présents
psql $DATABASE_URL -c "SELECT nom_secteur FROM sector_profiles;"
```
**Expected output**:
```
 nom_secteur
 -----------
 restaurant
 boutique
 immobilier
 sport
 dentaire
```
**Effort**: 1h  
**Responsable**: Dev  

---

### Tier 2: Important (24-48h)

#### 2.1 Créer DEPLOYMENT.md (Railway)
**Fichier**: `DEPLOYMENT.md` (NEW)  
**Contenu** (template):
```markdown
# Déploiement sur Railway

## Prérequis
- Compte Railway.app
- GitHub account + repo linked

## Étapes

### 1. Créer PostgreSQL + Redis
- New → Database → PostgreSQL 15+ → Provision
  - Enable pgvector extension via CLI:
    `psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS pgvector;"`
  
- New → Database → Redis 7+ → Provision

### 2. Déployer Backend
- New Service → Connect GitHub repo
- Environment: Node.js 20
- Start command: `npm run dev`
- Release command: `npm run migrate && npm run seed`
- Set env vars (see .env.example)
- Deploy

### 3. Déployer Worker (Service séparé)
- New Service → Same GitHub repo
- Environment: Node.js 20
- Start command: `npm run worker`
- Share DATABASE_URL + REDIS_URL from backend
- Deploy

### 4. Déployer Admin Console
- New Service → Same GitHub repo
- Root directory: admin-console
- Start command: `npm start` (après build automatique)
- Set BACKEND_URL = https://[backend-domain]
- Set BACKEND_ADMIN_KEY = same as backend's ADMIN_API_KEY
- Deploy

### 5. Post-Deploy Tests
- [ ] Backend health check: GET https://[backend]/health → {"statut":"ok"}
- [ ] Admin console loads: https://[admin-console] → dashboard
- [ ] Try onboarding via admin console (create first test client)
- [ ] Send test WhatsApp message → verify in logs it's received
```
**Effort**: 2h  
**Responsable**: DevOps / Didier  

---

#### 2.2 Créer LOCAL_TESTING.md (Webhook Mock)
**Fichier**: `LOCAL_TESTING.md` (NEW)  
**Contenu** (template):
```markdown
# Test Local avec Webhook Real WhatsApp

## Setup

1. Installer ngrok
   ```bash
   brew install ngrok  # Mac
   # ou télécharger depuis ngrok.com
   ```

2. Lancer ngrok (terminal 1)
   ```bash
   ngrok http 3000
   # → Note URL générée: https://abc123.ngrok.io
   ```

3. Mettre à jour Meta Dashboard
   - Go: developers.facebook.com → App → WhatsApp → Configuration
   - Set Callback URL: https://abc123.ngrok.io/webhook
   - Save

4. Tester (terminal 2)
   ```bash
   npm run dev
   ```

5. Envoyer message depuis WhatsApp Business
   - Numéro de test: [votre-whatsapp-business-number]
   - Message: "Bonjour"
   - Attendre réponse Claude

## Debugging

- Logs du backend: voir sortie `npm run dev`
- Webhook JSON: inspecteur ngrok (https://localhost:4040)
- DB: `psql $DATABASE_URL -c "SELECT * FROM messages ORDER BY created_at DESC LIMIT 5;"`
```
**Effort**: 1h  
**Responsable**: Didier  

---

#### 2.3 Créer CLIENT_ONBOARDING.md (Pas-à-pas)
**Fichier**: `CLIENT_ONBOARDING.md` (NEW)  
**Contenu** (template):
```markdown
# Onboarder un Nouveau Client — Pas-à-pas

## Option 1: CLI (Recommandé en production)

```bash
npm run onboard
# Répondre aux questions interactives:
# - Secteur: restaurant
# - Nom: Restaurant Le Gourmet
# - WhatsApp Business Number: +33612345678
# - Horaires: 12h-14h, 19h-23h
# - Tarifs: Menu découverte 35€, Menu chef 65€
```

Après succès, vous verrez:
```
Client créé avec succès.
ID: [uuid-client]

Checklist restante:
  [ ] Connecter Google Calendar (GET /oauth/google/start?client_id=...)
  [ ] Connecter HubSpot (renseigner hubspot_account_id en DB)
  [ ] Faire valider templates WhatsApp par Meta (sauf SAV 24h)
  [ ] Uploader base de connaissance (FAQ, menu)
  [ ] Envoyer premier test message
```

## Option 2: Admin Console UI

1. Accès: https://[admin-console]
2. Click: "+ Nouveau Client"
3. Remplir wizard
4. Submit
5. Voir client dans dashboard

## Connecter Google Calendar

```bash
# 1. Lancer OAuth
curl -X GET "http://localhost:3000/oauth/google/start?client_id=[client-uuid]"
# → Retourne URL de consent

# 2. Cliquer + autoriser
# → Redirection vers callback
# → Tokens stockés chiffrés en DB

# 3. Vérifier
psql $DATABASE_URL -c "SELECT google_calendar_id FROM clients WHERE id='[client-uuid]';"
```

## Uploader Connaissance Client

```bash
# 1. Créer fichier FAQ
cat > /tmp/restaurant_faq.txt << 'EOF'
Notre restaurant propose une cuisine gastronomique franco-italienne.

Nous sommes ouverts du mardi au dimanche, 12h-14h30 et 19h-23h.

Menu du jour : 18€ (plat + verre)
Menu découverte : 35€ (3 plats + vin)
Menu chef : 65€ (6 plats + vins)

Nous acceptons les réservations pour groupes > 6 personnes.
EOF

# 2. Ingérer
npm run ingest -- --client-id [client-uuid] --dir /tmp/restaurant_faq.txt

# 3. Vérifier dans RAG
# Envoyer message test "Quel est votre prix menu découverte ?"
# → Réponse doit citer "35€"
```

## Tester le Client

1. Envoyer message WhatsApp au numéro du client
2. Observer logs: `npm run dev` → voir pipeline
3. Réponse reçue après 2-5 secondes
```
**Effort**: 1.5h  
**Responsable**: Didier  

---

### Tier 3: Important mais non-bloquant (post-MVP)

#### 3.1 Améliorer Gestion des Erreurs
**Fichier**: `src/llm/converse.ts` (modify)  
**Cas à couvrir**:
- Claude timeout (30s) → fallback "Un moment SVP"
- Calendar API 503 → "Indisponible, réessayez plus tard"
- HubSpot rate limit → exponential backoff
- Database connection lost → queue en Redis, retry

**Effort**: 3h (post-MVP OK)  

---

#### 3.2 Ajouter Audit Log
**Fichier**: `migrations/004_audit_log.sql` (NEW)  
**Table**:
```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,  -- ADMIN_API_KEY or "system"
  action TEXT,   -- "CREATE_CLIENT", "DELETE_CONTACT", etc.
  resource_type TEXT,
  resource_id TEXT,
  changes JSONB,  -- before/after
  timestamp TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
```
**Effort**: 2h (post-MVP OK)  

---

#### 3.3 Dashboard Admin Console: Variables Editor
**Fichier**: `admin-console/components/VariablesEditor.tsx` (NEW)  
**Feature**:
- Afficher form avec tous les variables du secteur (horaires, tarifs, etc.)
- Editer en ligne
- Save → PATCH /admin/clients/:id

**Effort**: 2h (post-MVP OK)  

---

## 📋 Exécution Plan (Gantt simplifié)

```
Jour 1 (Jeudi):
├─ 09:00 - 13:00  → Test E2E (1.1)
├─ 13:00 - 14:00  → Lunch
├─ 14:00 - 15:00  → Vérifier URLs callback (1.2)
└─ 15:00 - 17:00  → Migration + Seed test (1.3)

Jour 2 (Vendredi):
├─ 09:00 - 11:00  → DEPLOYMENT.md (2.1)
├─ 11:00 - 12:00  → LOCAL_TESTING.md (2.2)
├─ 12:00 - 13:00  → Lunch
├─ 13:00 - 14:30  → CLIENT_ONBOARDING.md (2.3)
├─ 14:30 - 16:00  → Deploy to Railway + smoke test
└─ 16:00 - 17:00  → Buffer + fixes

Jour 3 (Samedi - Optional):
├─ 09:00 - 12:00  → Error handling improvements (3.1)
└─ 12:00 - 13:00  → Polish + review
```

---

## ✅ Checklist Pre-Launch

### Fonctionnel
- [ ] Test E2E passe (webhook → response)
- [ ] Migration + seed OK sur base vierge
- [ ] Onboarding CLI fonctionne
- [ ] Admin console crée client
- [ ] Webhook Meta envoie + traite messages
- [ ] Claude répond avec RAG + tools
- [ ] Calendar check + book fonctionne
- [ ] HubSpot push fonctionne (test lead)
- [ ] Escalation email/Slack fonctionne

### Sécurité
- [ ] ADMIN_API_KEY changé depuis default
- [ ] ENCRYPTION_KEY généré (64-char hex)
- [ ] RLS policies activées en production
- [ ] Tous les env vars HTTPS/secrets en place
- [ ] Pas de logs avec données sensibles

### Documentation
- [ ] DEPLOYMENT.md présent + testé
- [ ] LOCAL_TESTING.md présent
- [ ] CLIENT_ONBOARDING.md présent
- [ ] AGENTS.md à jour
- [ ] README.md français complet

### DevOps
- [ ] PostgreSQL 15+ avec pgvector activé
- [ ] Redis 7+ provisioned
- [ ] Backend service déployé + running
- [ ] Worker service déployé + running
- [ ] Admin console déployé + accessible
- [ ] Backup strategy défini (DB)
- [ ] Monitoring basique en place (uptime, logs)

### Test User Acceptance
- [ ] Un client pilote onboardé
- [ ] Échange complet de messages réussi
- [ ] RDV booked via conversation
- [ ] Lead qualifié pushed en HubSpot
- [ ] Admin console accessible, peut créer client

---

## 🚀 Success Criteria for MVP Launch

✅ **Critera Absolus**:
1. Webhook reçoit et traite messages
2. Claude génère réponses cohérentes
3. Tools (calendar, leads) exécutent sans erreur
4. Multi-tenant isolation respectée
5. Admin console crée/édite clients
6. Déploiement on Railway sans downtime
7. Documentation complet (Deploy + Onboarding + Troubleshooting)

✅ **Critères "Nice to Have"**:
- Tests > 60% coverage
- Monitoring + alertes
- Soft delete + audit logs
- UI variables editor

---

## 🆘 Escalation & Support

**Bloqué?** Référez-vous à `PROJECT_AUDIT.md` pour détails techniques.  
**Erreurs E2E?** Check `backend/README.md` Debugging Tips section.  
**Infrastructure?** Railway docs: railway.app/docs

---

**Version**: v1.0 - 2026-08-23  
**Statut**: Prêt pour exécution  
**Durée estimée**: 48-72 heures
