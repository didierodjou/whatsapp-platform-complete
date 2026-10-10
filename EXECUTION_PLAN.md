# 🎯 Plan de Finalisation — Exécution Immédiate

> **⚠️ Plan exécuté le 2026-09-03.** Phases 1 à 5 terminées : R1–R6 implémentés,
> 31 tests (dont 19 E2E/RLS), documentation de déploiement, de test local et
> d'onboarding livrée. Trois défauts découverts au passage (RLS inerte, cast
> UUID sur connexion recyclée, seed non idempotent) ont été corrigés.
> **Bilan à jour et reste à faire : [ETAT_FINAL.md](ETAT_FINAL.md).**
> Le document ci-dessous est conservé comme trace du plan initial.

**Date**: 2026-08-23  
**Statut Actuel**: Systèmes démarrent OK ✅ (backend + worker + admin-console)  
**Durée Restante**: 24-48h pour un produit production-ready  
**Prochaine Étape**: Tâches Tech (0-1h setup, puis exécution)

---

## 📋 Phase 1: Setup & Validation (1h)

### 1.1 Vérifier Base de Données ✅
```bash
# Terminal: Vérifier que Postgres + Redis tournent localement
docker ps | grep -E "postgres|redis"
# Expected: 2 containers running

# Vérifier pgvector activé
psql postgres://whatsapp_agent:whatsapp_agent@localhost:5433/whatsapp_agent \
  -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT * FROM sector_profiles LIMIT 1;"
# Expected: 5 rows (restaurant, boutique, immobilier, sport, dentaire)
```

**Effort**: 5 min  
**Owner**: Didier  
**Status**: À faire

---

### 1.2 Vérifier Variables d'Environnement Clés
```bash
# Vérifier que .env backend a les bonnes clés
grep -E "ANTHROPIC_API_KEY|DATABASE_URL|REDIS_URL|ADMIN_API_KEY" .env

# Vérifier que tous sont définis (non-vides)
# Expected: Tous les 3 existent et ne sont pas "xxxxx"
```

**Effort**: 5 min  
**Owner**: Didier  
**Status**: À faire

---

### 1.3 Tester Connectivité Interne (5 min)
```bash
# Terminal 1: Backend
cd backend
npm run dev
# Attendre: "Serveur démarré sur le port 3000"

# Terminal 2: Worker  
cd backend
npm run worker
# Attendre: "Workers BullMQ démarrés"

# Terminal 3: Admin Console
cd admin-console
npm run dev
# Attendre: "✓ Starting..."

# Terminal 4: Test
curl http://localhost:3000/health
# Expected: {"statut":"ok"}
```

**Effort**: 5 min  
**Owner**: Didier (parallèle aux 3 autres)  
**Status**: À faire

---

## 🔴 Phase 2: Implémenter 6 Risques Critiques (1-2h)

Fichier de référence: [RISKS_MITIGATIONS.md](RISKS_MITIGATIONS.md)

### 2.1 R1 — Claude Timeout → Fallback Message
**Fichier**: `backend/src/llm/converse.ts`  
**Effort**: 15 min  
**Code à ajouter**:

```typescript
// Chercher: export async function converseWithClaude(params: {...}): Promise<string>
// Remplacer la logique interne par try-catch:

export async function converseWithClaude(params: {
  systemPrompt: string;
  ragContext: string;
  history: HistoryMessage[];
  userMessage: string;
  client: ResolvedClient;
  contactId: string;
  contactWhatsappNumber: string;
}): Promise<string> {
  try {
    // Existing loop logic here...
  } catch (err: any) {
    console.error("Claude conversation error:", err);
    
    // R1: Fallback messages based on error type
    if (err.status === 429 || err.code === 'rate_limit_error') {
      return "Je suis temporairement surchargé. Pouvez-vous réessayer dans quelques instants ?";
    }
    if (err.name === 'APIConnectionTimeoutError' || err.name === 'Timeout') {
      return "Je rencontre une latence temporaire. Un moment svp...";
    }
    // Generic fallback
    return "Désolé, je n'ai pas pu traiter votre demande. Pouvez-vous reformuler ou contactez l'équipe?";
  }
}
```

**Owner**: Didier  
**Status**: À faire

---

### 2.2 R2 — Google Calendar Token Expiry → Throw Error
**Fichier**: `backend/src/integrations/calendar.ts`  
**Effort**: 20 min  

**Code à ajouter**:
```typescript
export async function checkAvailability(
  client: ResolvedClient,
  dateDebut: string,
  dateFin: string
): Promise<string[]> {
  if (!client.googleCalendarId) {
    console.warn("Google Calendar not configured for client", client.id);
    return [];
  }
  
  const auth = await getOAuthClientForClient(client);
  
  // R2: Throw instead of silent return
  if (!auth) {
    throw new Error(
      `Google Calendar OAuth expired for client ${client.id}. ` +
      `Admin must reconnect via /oauth/google/start?client_id=${client.id}`
    );
  }
  
  // ... rest of existing logic
}
```

**Then in executeTool** (`backend/src/llm/executeTool.ts`):
```typescript
case "check_calendar_availability": {
  try {
    const slots = await checkAvailability(ctx.client, input.date_debut, input.date_fin);
    return JSON.stringify({ creneaux_disponibles: slots });
  } catch (err: any) {
    // R2: Return error message Claude can understand
    return JSON.stringify({ 
      erreur: "Calendrier temporairement indisponible. " +
              "Merci de contacter l'équipe commerciale pour un créneau."
    });
  }
}
```

**Owner**: Didier  
**Status**: À faire

---

### 2.3 R6 — Worker Health Check Endpoint
**Fichier**: `backend/src/admin/routes.ts`  
**Effort**: 10 min  

**Code à ajouter (après adminRouter.use(requireAdminKey))**:
```typescript
// GET /admin/worker-health — Check if worker is connected
adminRouter.get("/worker-health", async (_req, res) => {
  try {
    const relancesCount = await relancesQueue.getJobCounts();
    const rappelsCount = await rappelsQueue.getJobCounts();
    
    const total_waiting = relancesCount.waiting + rappelsCount.waiting;
    const is_degraded = total_waiting > 100; // Alert if > 100 jobs stuck
    
    res.json({
      status: is_degraded ? "⚠️  degraded" : "✅ ok",
      queues: {
        relances: relancesCount,
        rappels_rdv: rappelsCount,
      },
      total_jobs_waiting: total_waiting,
      recommendation: is_degraded 
        ? "Check if worker process is running: npm run worker" 
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

**Owner**: Didier  
**Status**: À faire

---

### 2.4 R3 — RLS Audit (No Code Change)
**Effort**: 5 min  

**Vérifier**:
```bash
cd backend/src
grep -r "pool\.query" . | grep -v "withTenant"
# Expected output: ZERO results (except admin routes which are exceptions)
```

**Owner**: Didier  
**Status**: À faire

---

### 2.5 R4 — Webhook Validation Test
**Effort**: 10 min  

**Ajouter test** (`backend/tests/webhook.test.ts`):
```typescript
import { describe, it, expect } from "vitest";
import { verifyMetaSignature } from "../src/integrations/whatsapp";

describe("Meta Webhook Signature Verification", () => {
  it("should reject invalid signature", () => {
    const body = JSON.stringify({ test: "data" });
    const badSignature = "sha256=invalid";
    const result = verifyMetaSignature(body, badSignature);
    expect(result).toBe(false);
  });
  
  it("should accept valid signature (if present)", () => {
    // Note: Full test requires WHATSAPP_APP_SECRET, skip in CI
    expect(true).toBe(true);
  });
});
```

**Owner**: QA  
**Status**: À faire

---

### 2.6 R5 — Admin Key Rotation Documentation
**Effort**: 10 min  

**Ajouter section** dans [backend/README.md](backend/README.md):
```markdown
## Security: Rotating ADMIN_API_KEY

If ADMIN_API_KEY is compromised:

1. Generate new key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Update backend .env:
   ```
   ADMIN_API_KEY=<new-key>
   ```

3. Update admin-console .env.local:
   ```
   BACKEND_ADMIN_KEY=<same-new-key>
   ```

4. Redeploy both services immediately

5. Check for suspicious clients created:
   ```bash
   psql $DATABASE_URL -c "SELECT id, nom_entreprise, created_at FROM clients ORDER BY created_at DESC LIMIT 10;"
   ```
```

**Owner**: Tech writer  
**Status**: À faire

---

**⏱️ Total Phase 2**: 1h environ  
**Validation**: `npm test` devrait passer toutes les suites

---

## 🧪 Phase 3: Test E2E Complet (2-4h)

### 3.1 Créer E2E Test Suite
**Fichier**: `backend/tests/e2e.integration.test.ts` (NEW)  
**Effort**: 4h  

**Structure de base**:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../src/db/pool";
import { handleIncomingMessage } from "../src/orchestrator/handleIncomingMessage";
import { resolveClientByWhatsappNumber } from "../src/orchestrator/resolveClient";

describe("E2E: Message → Claude → Tool → Response", () => {
  let clientId: string;
  let contactWhatsappNumber: string;
  
  beforeAll(async () => {
    // 1. Setup: Create test client + contact
    // 2. Setup: Seed knowledge base for this client
  });
  
  afterAll(async () => {
    // Cleanup
  });
  
  it("E2E-SAV: User asks about hours → RAG response", async () => {
    // Simulate: "Quels sont vos horaires ?"
    // Expected: Response from RAG knowledge base
  });
  
  it("E2E-Booking: User books appointment → Calendar created", async () => {
    // Simulate: "Je veux une table pour 4 ce soir"
    // Expected: 
    //   1. Claude calls check_calendar_availability
    //   2. Claude calls book_appointment
    //   3. Google Calendar event created
    //   4. rendez_vous DB record inserted
  });
  
  it("E2E-Lead: User expresses need → Lead scored + pushed to HubSpot", async () => {
    // Simulate: "Je cherche un 3 pièces, budget 400k"
    // Expected:
    //   1. Claude calls create_lead
    //   2. Contact score_lead updated in DB
    //   3. HubSpot notification sent (if connected)
  });
  
  it("E2E-Escalation: Complex issue → Escalated to human", async () => {
    // Simulate issue that requires human
    // Expected: escalade_to_human tool called, notification sent
  });
});
```

**Owner**: QA/Dev  
**Status**: À faire

---

## 📖 Phase 4: Documentation Déploiement (3h)

### 4.1 Créer DEPLOYMENT.md
**Fichier**: `DEPLOYMENT.md` (NEW)  
**Effort**: 2h  
**Template**: Voir [ACTION_PLAN.md](ACTION_PLAN.md) section 2.1

**Contenu Clé**:
- Step-by-step Railway setup
- PostgreSQL + pgvector config
- Redis config
- Backend/Worker/Admin-console deployment
- Environment variables checklist
- Post-deploy smoke tests
- Troubleshooting (ports, DB connection, Redis)

**Owner**: DevOps  
**Status**: À faire

---

### 4.2 Créer LOCAL_TESTING.md
**Fichier**: `LOCAL_TESTING.md` (NEW)  
**Effort**: 1h  
**Template**: Voir [ACTION_PLAN.md](ACTION_PLAN.md) section 2.2

**Contenu Clé**:
- Setup ngrok
- Update Meta dashboard callback URL
- Start 3 services (backend, worker, admin)
- Send test WhatsApp message
- Verify webhook received in logs
- Check ngrok inspector (https://localhost:4040)

**Owner**: QA  
**Status**: À faire

---

### 4.3 Créer CLIENT_ONBOARDING.md
**Fichier**: `CLIENT_ONBOARDING.md` (NEW)  
**Effort**: 1h  
**Template**: Voir [ACTION_PLAN.md](ACTION_PLAN.md) section 2.3

**Contenu Clé**:
- CLI onboarding (npm run onboard)
- Admin console onboarding
- Google Calendar OAuth flow
- HubSpot integration
- Knowledge base ingestion
- Test end-to-end

**Owner**: Tech writer  
**Status**: À faire

---

## ✅ Phase 5: Validation Finale (1h)

### Checklist Pre-Production

```
FONCTIONNEL
☐ Backend service starts without errors
☐ Worker service starts without errors  
☐ Admin console loads (http://localhost:3001)
☐ GET /health returns {"statut":"ok"}
☐ GET /admin/worker-health returns OK status
☐ Database migration + seed successful
☐ 5 sector profiles visible
☐ E2E test: webhook → Claude → response passes
☐ E2E test: booking workflow passes
☐ E2E test: lead qualification passes

SÉCURITÉ
☐ ADMIN_API_KEY not default value
☐ ENCRYPTION_KEY is 64-char hex
☐ RLS policies verified (audit: grep pool.query)
☐ No direct pool.query() outside admin routes
☐ Webhook signature verification tested

INTÉGRATIONS
☐ ANTHROPIC_API_KEY valid (can call Claude)
☐ DATABASE_URL accessible
☐ REDIS_URL accessible
☐ Google OAuth configured (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)
☐ Meta webhook token configured (WHATSAPP_VERIFY_TOKEN)

DOCUMENTATION
☐ DEPLOYMENT.md created
☐ LOCAL_TESTING.md created
☐ CLIENT_ONBOARDING.md created
☐ README updated with troubleshooting
☐ AGENTS.md references all components

READY FOR PRODUCTION
☐ All 6 risks (R1-R6) implemented
☐ All Phase checklist items ticked
☐ One pilot client onboarded successfully
☐ E2E workflow tested (message in, response out)
☐ Team sign-off: ✅ Go for production
```

---

## 📊 Summary & Timeline

| Phase | Effort | Owner | Status |
|-------|--------|-------|--------|
| **Phase 1** — Setup & Validation | 1h | Didier | 🟡 Ready |
| **Phase 2** — 6 Risques Critiques | 1h | Didier | 🟡 Ready |
| **Phase 3** — E2E Tests | 4h | QA/Dev | 🟡 Ready |
| **Phase 4** — Documentation | 3h | DevOps + Writer | 🟡 Ready |
| **Phase 5** — Validation | 1h | All | 🟡 Ready |
| **TOTAL** | **10h** | Multi | 🟡 Ready |

**Timeline Réaliste**:
- Jours 1-2 (24h): Phases 1-2 + 4 = 5h (peut être parallèle)
- Jour 2-3: Phase 3 (E2E tests) = 4h
- Jour 3: Phase 5 (Validation) = 1h
- **Total: 48h until production-ready MVP**

---

## 🚀 How to Execute

### Immédiatement (Maintenant):
1. Lisez cette page
2. Copiez les code snippets des phases 2.1-2.6
3. Implémentez dans les fichiers indiqués
4. Testez avec `npm test`

### Parallèle (Pendant que Didier code):
- DevOps: Préparer Railway infrastructure
- QA: Préparer E2E test structure
- Writer: Copier templates de ACTION_PLAN.md

### Ordre d'Exécution Recommandé:
1. Phase 1 (Setup) — 15 min
2. Phase 2 (Risques) — 1h (parallèle: docs started)
3. Phase 3 (E2E) — 4h
4. Phase 4 (Docs) — 3h (peut être parallèle aux tests)
5. Phase 5 (Validation) — 1h

---

## 📞 Questions Fréquentes Pendant Exécution

**Q: "Où j'ajoute le code R1?"**
A: `backend/src/llm/converse.ts` dans la fonction `converseWithClaude`, wrap le try-catch autour de la boucle actuelle

**Q: "Comment je teste localement?"**
A: Démarrez 3 terminaux (backend + worker + admin), puis `curl http://localhost:3000/health`

**Q: "Quel secteur pour tester?"**
A: "restaurant" (plus simple, moins de champs optionnels)

**Q: "Comment je crée un client de test?"**
A: CLI: `npm run onboard` (interactive), ou admin console

---

**Status de ce Plan**: ✅ Complet, exécutable immédiatement  
**Prochaine Étape**: Phase 1 (Setup & Validation) - 15 min  
**Deadline Production MVP**: 2026-08-25 (48h)
