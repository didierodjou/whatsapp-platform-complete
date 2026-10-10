# Risques & Mitigations Rapides — WhatsApp Agent Platform

**Durée de lecture**: 5 min  
**Durée d'implémentation des fixes rapides**: 1-2 heures  
**Référence**: PROJECT_AUDIT.md, ACTION_PLAN.md

---

## 🔴 Risques Critiques (Bloquer si non-résolu)

### R1: Claude Timeout ou Erreur → Message jamais envoyé
**Probabilité**: Moyenne | **Impact**: Haute | **CVSS**: 6.5

**Scénario**: 
- User envoie message
- Claude API timeout (>30s) ou erreur 429 (rate limit)
- Pas de réponse envoyée au contact
- Contact pense le service est down

**Symptômes**:
```
[logs] Error: Claude API timeout
No error handling → message silently dropped
Contact never sees response
```

**Fix Rapide (15 min)** — Fichier: `src/llm/converse.ts`
```typescript
// Add try-catch + fallback message
export async function converseWithClaude(params: {
  // ...
}): Promise<string> {
  try {
    // existing logic
  } catch (err) {
    console.error("Claude error:", err);
    // Fallback message
    if (err.status === 429) {
      return "Je suis temporairement surchargé. Pouvez-vous réessayer dans quelques instants ?";
    }
    if (err.name === 'APIConnectionTimeoutError') {
      return "Je rencontre une latence temporaire. Un moment svp...";
    }
    // Generic fallback
    return "Désolé, je n'ai pas pu traiter votre demande. Pouvez-vous reformuler ou contactez l'équipe?";
  }
}
```

**Test**:
```bash
# Simuler timeout en mockt Anthropic avec delay
npm test -- src/llm/converse.test.ts
```

---

### R2: Google Calendar OAuth Tokens Expirés → Booking échoue silencieusement
**Probabilité**: Haute (30+ jours d'inactivité client) | **Impact**: Haute | **CVSS**: 5.5

**Scénario**:
- Client A connecte Google Calendar (tokens stockés, expiry=30j)
- 31 jours plus tard, prospect veut booking
- `checkAvailability` appelle Google API avec refresh_token expiré
- Returns `[]` (aucun créneau au lieu d'erreur)
- Claude dit "Aucun créneau disponible" → prospect pense fermé

**Symptômes**:
```
[logs] No availability returned (empty array)
Claude: "Malheureusement, aucun créneau n'est disponible"
```

**Fix Rapide (20 min)** — Fichier: `src/integrations/calendar.ts`
```typescript
export async function checkAvailability(
  client: ResolvedClient,
  dateDebut: string,
  dateFin: string
): Promise<string[]> {
  if (!client.googleCalendarId) {
    console.warn("Google Calendar not configured for client", client.id);
    return []; // OK: user will understand to contact
  }
  
  const auth = await getOAuthClientForClient(client);
  if (!auth) {
    // NEW: Throw error instead of silent return
    throw new Error(
      `Google Calendar OAuth expired for client ${client.id}. ` +
      `Admin must reconnect via /oauth/google/start`
    );
  }
  
  // ... rest of logic
}
```

**Then in executeTool**:
```typescript
case "check_calendar_availability": {
  try {
    const slots = await checkAvailability(ctx.client, input.date_debut, input.date_fin);
    return JSON.stringify({ creneaux_disponibles: slots });
  } catch (err) {
    // Return error message Claude can handle
    return JSON.stringify({ 
      erreur: "Calendrier temporairement indisponible. " +
              "Merci de contacter l'équipe commerciale pour un créneau."
    });
  }
}
```

**Admin notification**:
- Add endpoint: `GET /admin/clients/:id/calendar-status`
- Returns: `{ connected: bool, tokens_expire_at: date, needs_reconnect: bool }`

---

### R3: RLS Policy Bypass → Data Leakage Between Clients
**Probabilité**: Basse (code-level) | **Impact**: Critique | **CVSS**: 9.0

**Scénario**:
- Developer accidentellement utilise `pool.query()` au lieu de `withTenant()`
- Query returns données de TOUS les clients
- Client A voit conversations de Client B

**Symptômes**:
```
[DB logs] ERROR: new row violates row-level security policy
OR
No error but queries return wrong client_id
```

**Prevention (not a fix, already in place)**:
```typescript
// In db/pool.ts — already implemented ✅
export async function withTenant<T>(
  clientId: string,
  fn: (db: PoolClient) => Promise<T>
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL app.current_client_id = $1", [clientId]);
    // ^^^ RLS will reject any query outside this scope
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } finally {
    db.release();
  }
}
```

**Auditing (5 min)** — Search for direct `pool.query()`:
```bash
grep -r "pool\.query" src/ | grep -v "withTenant"
# Should return ZERO matches outside of special cases
# (Only exceptions: admin routes that explicitly want all clients)
```

---

## 🟠 Risques Importants (Dégrader UX sinon)

### R4: Webhook Meta Signature Invalid → All Messages Rejected
**Probabilité**: Moyenne (env config) | **Impact**: Haute | **CVSS**: 6.0

**Scénario**:
- Admin copies wrong `WHATSAPP_VERIFY_TOKEN` to `.env`
- Meta sends webhook with correct signature but app expects different
- All webhooks return 401
- Platform appears completely broken

**Symptômes**:
```
[logs] Webhook rejected: 401 Unauthorized
Meta retries 3x, then stops
```

**Prevention (5 min)**:
```bash
# 1. Verify token matches Meta dashboard exactly
# Copy from: developers.facebook.com → App → WhatsApp → Configuration

# 2. Test locally
curl -X POST http://localhost:3000/webhook \
  -H "X-Hub-Signature-256: sha256=..." \
  -H "Content-Type: application/json" \
  -d '{"object":"whatsapp_business_account"}'
# Should return 401 if signature is intentionally bad
# Should return 200 if signature is good

# 3. Add validation endpoint
# GET /admin/webhook-status
# Returns: { verified: bool, last_received_at: timestamp, errors_24h: number }
```

---

### R5: Admin Key Leaked → Unauthorized Client Creation
**Probabilité**: Moyenne (human error) | **Impact**: Alta | **CVSS**: 7.0

**Scénario**:
- Dev shares `ADMIN_API_KEY` in Slack accidentally
- Attacker creates fake clients pointing to their WhatsApp number
- Receives all messages meant for legit clients

**Symptômes**:
```
[logs] Unusual number of new clients created
[alerts] Multiple POST /admin/clients from unexpected IPs
```

**Immediate Action (10 min)**:
```bash
# 1. Rotate key immediately
# Generate new key:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Update .env (backend) + .env.local (admin-console)
ADMIN_API_KEY=<new-key>

# 3. Redeploy
git push → Railway auto-redeploy

# 4. Invalidate old key:
# DELETE all sessions/tokens if you have them
```

**Future (post-MVP)**:
- Add API key versioning + expiry
- Add rate limiting per API key
- Add audit log for ALL admin operations

---

### R6: Worker Not Running → Relances/Rappels Never Sent
**Probabilité**: Haute (ops oversight) | **Impact**: Haute | **CVSS**: 6.0

**Scénario**:
- DevOps deploys backend but forgets worker service
- Relances et rappels s'accumulent en Redis
- Clients ne reçoivent jamais leur message de relance
- Après 7j, 1000+ jobs sont stuck

**Symptômes**:
```
[logs backend] "Scans récurrents planifiés dans Redis"
[Redis] KEYS pattern:bull:relances:* → HUGE queue
[DB] relances_programmees.statut = 'en_attente' for 7+ days
```

**Prevention (5 min)** — Add health check:
```typescript
// In src/server.ts, after scheduleRecurringScans()
import { redisConnection } from "./scheduler/queues";

async function checkWorkerHealth() {
  try {
    const info = await redisConnection.info('replication');
    const clientList = await redisConnection.client('list');
    
    // If worker is connected, we see it here
    const hasWorker = clientList.includes('name=worker');
    
    if (!hasWorker) {
      console.warn("⚠️  WARNING: No worker connected to Redis!");
      console.warn("Run 'npm run worker' in a separate terminal!");
    }
  } catch (err) {
    console.error("Cannot check worker health:", err);
  }
}

// Call during startup
await checkWorkerHealth();
```

**Endpoint**:
```typescript
app.get("/admin/worker-health", async (_req, res) => {
  const queues = [relancesQueue, rappelsQueue];
  const health = {};
  
  for (const queue of queues) {
    const counts = await queue.getJobCounts();
    health[queue.name] = {
      waiting: counts.waiting,
      active: counts.active,
      delayed: counts.delayed,
      failed: counts.failed,
    };
  }
  
  // Alert if waiting queue is huge (> 100 jobs for > 1 hour)
  const hasIssue = Object.values(health).some(q => q.waiting > 100);
  
  res.json({
    status: hasIssue ? "⚠️  degraded" : "✅ ok",
    queues: health,
    recommendation: hasIssue ? "Check if worker is running" : null,
  });
});
```

---

## 🟡 Risques Mineurs (Nice-to-Have Fixes)

| Risque | Symptôme | Fix | Effort |
|--------|---------|-----|--------|
| **R7: Rate Limit 120/min trop strict** | Clients légitimes throttled | Ajouter `RATE_LIMIT_PER_MINUTE` env var | 15 min |
| **R8: Logs contiennent numéros WhatsApp** | Data leak in Sentry/CloudWatch | Mask sensitive in logs | 20 min |
| **R9: Pas de soft delete RGPD** | Contact supprimé → pas de trace | Add `deleted_at` column | 45 min |
| **R10: HubSpot 429 pas retiré** | Lead création rate-limited | Add exponential backoff | 30 min |

---

## ⏱️ Priorité d'Implémentation

**Must Do (Blockers, 1h total)**:
1. ✅ R1 — Claude error fallback (15 min)
2. ✅ R2 — Google Calendar token expiry (20 min)
3. ✅ R3 — RLS audit (5 min)
4. ✅ R4 — Webhook verification test (5 min)
5. ✅ R6 — Worker health check (10 min)

**Should Do (Important, 1-2h)**:
6. ✅ R5 — Admin key rotation docs (10 min)
7. ✅ R7 — Rate limit configurable (15 min)

**Nice to Do (Post-MVP)**:
8. R8, R9, R10 — Async improvements

---

## Checklist de Mitigation (Before Launch)

```
BEFORE PRODUCTION:
☐ Implement R1 (Claude fallback)
☐ Implement R2 (Calendar token expiry)
☐ Audit R3 (no direct pool.query)
☐ Test R4 (webhook validation)
☐ Deploy R6 (worker health check)
☐ Document R5 (key rotation procedure)
☐ Configure R7 (rate limit)
☐ Worker service definitely running
☐ Admin key changed from default
☐ ENCRYPTION_KEY generated
☐ All env vars set correctly

MONITORING (Post-Launch):
☐ Alert if queue.waiting > 100 (R6)
☐ Alert if webhook 401 spike (R4)
☐ Alert if RLS policy errors (R3)
☐ Daily: Check token expiry (R2)
```

---

## Impact Score Summary

| Risk | Likelihood | Severity | Impact | Time-to-Fix |
|------|-----------|----------|--------|-------------|
| R1 | Med | High | UX broken | 15 min |
| R2 | High | High | Bookings fail | 20 min |
| R3 | Low | Critical | Data leak | 5 min (audit) |
| R4 | Med | High | Platform down | 5 min |
| R5 | Med | High | Account hijack | 10 min |
| R6 | High | High | Messages lost | 10 min |
| **TOTAL CRITICAL PATH** | — | — | — | **~60 min** |

---

**Recommendation**: Implement R1-R6 before launching to production. Total effort = 1 hour, saves 10+ hours of post-launch firefighting.

**Next**: Once all 6 risks mitigated, proceed with ACTION_PLAN.md
