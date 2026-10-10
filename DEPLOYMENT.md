# Déploiement en production (Railway)

Guide pas-à-pas pour passer du local à une production fonctionnelle.
Trois services applicatifs + deux bases : **backend API**, **worker**,
**admin-console**, **PostgreSQL (pgvector)**, **Redis**.

Pour tester en local avec de vrais messages WhatsApp avant de déployer, voir
[LOCAL_TESTING.md](LOCAL_TESTING.md). Pour brancher un client une fois déployé,
voir [CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md).

---

## 0. Prérequis

| Élément | Détail |
|---|---|
| Compte Railway | [railway.app](https://railway.app) — plan Hobby suffisant pour démarrer |
| Repo Git | Le code poussé sur GitHub (Railway déploie depuis le repo) |
| App Meta | WhatsApp Business Cloud API configurée (voir `backend/README.md`) |
| Clés API | Anthropic, Voyage AI (embeddings), Google OAuth, HubSpot, Resend/Slack |

Coût indicatif : ~100–150 $/mois d'infrastructure, plus la consommation
Anthropic/Voyage/Meta à l'usage.

---

## 1. Provisionner PostgreSQL + Redis

Dans un nouveau projet Railway :

1. **New → Database → PostgreSQL** (v15+).
2. **New → Database → Redis** (v7+).

L'extension `pgvector` est créée automatiquement par la migration
`001_init.sql` (`CREATE EXTENSION IF NOT EXISTS vector`). L'image Postgres de
Railway l'embarque ; si `npm run migrate` échoue sur cette ligne, l'image ne
contient pas pgvector — bascule sur un Postgres avec pgvector (ex. add-on
dédié, ou Supabase/Neon en externe) et remets simplement `DATABASE_URL` à jour.

---

## 2. Déployer le backend API

1. **New → GitHub Repo** → sélectionne le repo.
2. **Settings → Root Directory** : `backend`
3. **Settings → Build Command** : `npm run build`
4. **Settings → Start Command** : `npm start`
5. **Settings → Deploy → Pre-Deploy Command** : `npm run migrate && npm run seed`
   (`seed` est idempotent : `ON CONFLICT (nom_secteur) DO NOTHING`.)
6. **Variables** : reprends l'intégralité de `backend/.env.example` (§6 ci-dessous),
   avec `DATABASE_URL` et `REDIS_URL` référencés depuis les services Railway :
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   ```
7. **Settings → Networking → Generate Domain** → note l'URL publique, elle
   devient `BASE_URL`.

> ⚠️ `NODE_ENV=production` et `BASE_URL=https://<ton-domaine>` (sans slash final) :
> `BASE_URL` sert à construire les liens OAuth Google renvoyés à l'onboarding.

---

## 3. Déployer le worker (service séparé, obligatoire)

Le serveur web planifie les scans dans Redis, mais **n'envoie rien lui-même** :
sans ce service, relances et rappels de RDV restent en attente indéfiniment.

1. **New → GitHub Repo** → même repo.
2. **Root Directory** : `backend`
3. **Build Command** : `npm run build`
4. **Start Command** : `npm run worker`
5. **Variables** : les mêmes que le backend (mêmes `DATABASE_URL`, `REDIS_URL`,
   `ANTHROPIC_API_KEY`, `WHATSAPP_*`, `ENCRYPTION_KEY`…).
6. Pas de domaine public à générer (aucun port exposé).

Le nombre d'instances web et de workers se scale indépendamment : BullMQ
garantit qu'un job n'est traité qu'une fois même avec plusieurs workers.

---

## 4. Déployer l'admin-console

1. **New → GitHub Repo** → même repo.
2. **Root Directory** : `admin-console`
3. **Build Command** : `npm run build` — **Start Command** : `npm start`
4. **Variables** :
   ```
   BACKEND_URL=https://<domaine-du-backend>
   BACKEND_ADMIN_KEY=<identique à ADMIN_API_KEY du backend>
   ```
5. **Generate Domain**.

`BACKEND_ADMIN_KEY` n'est lue que dans les API routes Next.js (server-side) :
elle n'atteint jamais le bundle navigateur.

> ⚠️ L'admin-console n'a **pas** d'authentification propre. Tant qu'elle n'en a
> pas, ne lui génère pas de domaine public : garde-la en réseau privé Railway,
> ou place-la derrière un proxy authentifié / une Access Policy.

---

## 5. Rôle applicatif Postgres (isolation multi-tenant réelle)

**À faire une fois, après la première migration.** La RLS (migrations 002/004/005)
isole les données par client — mais Postgres **ignore toute policy pour un
superutilisateur**. Or l'utilisateur fourni par défaut par Railway (`postgres`)
en est un : connecté avec lui, la RLS ne protège rien.

Crée un rôle applicatif dédié, non-superutilisateur, et fais tourner backend et
worker avec lui :

```sql
-- via `railway connect Postgres` ou psql $DATABASE_URL
CREATE ROLE whatsapp_app LOGIN PASSWORD '<mot-de-passe-fort>';
GRANT USAGE ON SCHEMA public TO whatsapp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whatsapp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whatsapp_app;

-- pour les tables créées par les migrations futures
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO whatsapp_app;
```

Puis, dans les variables du **backend** et du **worker** uniquement :

```
DATABASE_URL=postgres://whatsapp_app:<mot-de-passe>@<host>:<port>/<db>
```

Garde l'utilisateur superutilisateur d'origine pour `npm run migrate`
(Pre-Deploy Command) — les migrations ont besoin de créer/altérer des objets.

Vérification (doit renvoyer `f` / `false`) :
```bash
psql $DATABASE_URL -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;"
```

Et que la RLS est bien forcée sur les 6 tables métier :
```bash
psql $DATABASE_URL -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
  WHERE relname IN ('contacts','conversations','rendez_vous','relances_programmees','knowledge_base_chunks','escalades');"
# attendu : t | t sur les 6 lignes
```

---

## 6. Checklist des variables d'environnement

### Backend + worker (mêmes valeurs des deux côtés)

| Variable | Obligatoire | Note |
|---|---|---|
| `PORT` | non | Railway l'injecte |
| `NODE_ENV` | oui | `production` |
| `BASE_URL` | oui | `https://<domaine-backend>` — utilisée dans les liens OAuth |
| `DATABASE_URL` | oui | rôle `whatsapp_app` (voir §5) |
| `REDIS_URL` | oui | référence le service Redis |
| `ANTHROPIC_API_KEY` | oui | sinon aucune réponse générée |
| `ANTHROPIC_MODEL` | non | défaut `claude-sonnet-4-6` |
| `WHATSAPP_VERIFY_TOKEN` | oui | identique au champ « Token de vérification » côté Meta |
| `WHATSAPP_APP_SECRET` | oui | sans lui, **tous** les webhooks sont rejetés en 401 |
| `WHATSAPP_ACCESS_TOKEN` | oui | token permanent (compte système Meta) |
| `WHATSAPP_API_VERSION` | non | défaut `v20.0` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | si RDV | OAuth Calendar par client |
| `GOOGLE_REDIRECT_URI` | si RDV | `https://<domaine-backend>/oauth/google/callback` |
| `HUBSPOT_ACCESS_TOKEN` | si CRM | token privé HubSpot |
| `SLACK_WEBHOOK_URL` | non | canal d'escalade |
| `RESEND_API_KEY` + `ESCALATION_EMAIL_FROM` / `_TO` | non | email d'escalade |
| `VOYAGE_API_KEY` | oui | embeddings RAG — sans lui, aucune base de connaissance |
| `ENCRYPTION_KEY` | oui | 64 caractères hex, **immuable** une fois des clients connectés |
| `ADMIN_API_KEY` | oui | protège toutes les routes `/admin/*` |

Génération des secrets :
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY et ADMIN_API_KEY
```

> `ENCRYPTION_KEY` chiffre les tokens OAuth Google en base (AES-256-GCM). La
> changer rend les tokens existants indéchiffrables : les clients concernés
> devraient tous repasser par `/oauth/google/start`.

### Admin-console
`BACKEND_URL`, `BACKEND_ADMIN_KEY`.

---

## 7. URLs externes à mettre à jour après déploiement

| Où | Quoi |
|---|---|
| Meta for Developers → WhatsApp → Configuration | Callback URL `https://<domaine-backend>/webhook`, token = `WHATSAPP_VERIFY_TOKEN`, champ `messages` abonné |
| Google Cloud Console → Identifiants OAuth | URI de redirection autorisée `https://<domaine-backend>/oauth/google/callback` (à l'identique, sans slash final) |
| Variables admin-console | `BACKEND_URL` en HTTPS, pas `localhost` |

---

## 8. Tests de fumée post-déploiement

```bash
BACKEND=https://<domaine-backend>
ADMIN_KEY=<ADMIN_API_KEY>

# 1. Le service répond
curl -s $BACKEND/health
# → {"statut":"ok"}

# 2. Le worker est vivant et les queues ne s'accumulent pas
curl -s -H "x-admin-key: $ADMIN_KEY" $BACKEND/admin/worker-health
# → {"status":"✅ ok", "total_jobs_waiting":0, ...}

# 3. Les 5 profils sectoriels sont bien seedés
curl -s -H "x-admin-key: $ADMIN_KEY" $BACKEND/admin/sector-profiles
# → restaurant, boutique, immobilier, sport, dentaire

# 4. La clé admin protège réellement les routes
curl -s -o /dev/null -w "%{http_code}\n" $BACKEND/admin/clients
# → 401

# 5. Le webhook rejette une requête non signée
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BACKEND/webhook -d '{}' -H "Content-Type: application/json"
# → 401

# 6. La vérification de webhook Meta fonctionne
curl -s "$BACKEND/webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=ping"
# → ping
```

Puis, bout en bout : onboarde un client de test
([CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md)), envoie-lui un message WhatsApp,
et vérifie la réponse — et sa trace en base :

```bash
psql $DATABASE_URL -c "SELECT role, left(contenu, 60), timestamp FROM conversations ORDER BY timestamp DESC LIMIT 5;"
```

---

## 9. Dépannage

| Symptôme | Cause probable | Correction |
|---|---|---|
| Webhook toujours en 401 | `WHATSAPP_APP_SECRET` absent ou erroné | La signature est calculée sur le corps brut : vérifie la valeur dans Meta → Paramètres → Basique |
| Meta refuse de valider le webhook | `WHATSAPP_VERIFY_TOKEN` différent des deux côtés | Aligner les deux valeurs, re-valider |
| Message reçu mais aucune réponse | Aucun client sur ce numéro | `SELECT whatsapp_business_number FROM clients;` — doit correspondre **exactement** au `display_phone_number` du webhook |
| Réponse générée mais jamais reçue | `whatsapp_phone_number_id` manquant sur le client | `PATCH /admin/clients/:id` avec le Phone Number ID Meta |
| Relances/rappels jamais envoyés | Service worker arrêté | `GET /admin/worker-health` ; redémarrer le service worker |
| `invalid input syntax for type uuid: ""` | Migration 005 non appliquée | `npm run migrate` |
| Requêtes vides côté admin | RLS forcée + lookup hors `withAdmin` | Utiliser `withAdmin()` pour les lectures cross-tenant (`src/db/pool.ts`) |
| `extension "vector" is not available` | Image Postgres sans pgvector | Voir §1 |
| Réponses sans contexte métier | `VOYAGE_API_KEY` absente → aucun chunk indexé | Renseigner la clé, réingérer la base de connaissance |
| `ERR_CRYPTO_INVALID_KEYLEN` | `ENCRYPTION_KEY` pas en 64 hex | Régénérer (et reconnecter les Calendars) |

---

## 10. Sauvegarde et exploitation

- **Backups** : active les backups automatiques du service Postgres Railway
  (quotidiens minimum). Test de restauration recommandé avant le premier client
  réel.
- **Logs** : onglet Deployments de chaque service. Les erreurs de pipeline sont
  préfixées `Claude conversation error:`, `Calendar availability error:`,
  `Erreur traitement webhook WhatsApp:`.
- **Supervision minimale** : un check HTTP externe sur `/health` (uptime) et une
  vérification quotidienne de `/admin/worker-health`
  (`total_jobs_waiting > 100` → worker probablement arrêté).
- **Rotation de `ADMIN_API_KEY`** : procédure dans
  [backend/README.md](backend/README.md#rotation-de-ladmin-api-key-r5) —
  penser à mettre à jour `BACKEND_ADMIN_KEY` de l'admin-console dans le même
  déploiement.
