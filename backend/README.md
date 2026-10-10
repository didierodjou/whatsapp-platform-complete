# Agent WhatsApp Business — plateforme multi-clients / multi-secteurs

Système d'agent WhatsApp Business automatisé (SAV, qualification de leads, prise
de rendez-vous, relances, newsletters) piloté par Claude, conçu pour être
onboardé sur un nouveau client en quelques minutes — sans toucher au code.

## Architecture en 3 couches

```
Couche 1 — CORE          orchestrateur, tools, sécurité, webhook   (src/)
Couche 2 — SECTEUR        template de prompt + workflows par secteur (seeds/sector_profiles.sql)
Couche 3 — CLIENT         nom, horaires, tarifs, agenda, CRM        (table clients)
```

À chaque message reçu : le numéro WhatsApp Business qui l'a reçu identifie le
client → son secteur est chargé → le template de prompt du secteur est rempli
avec les variables du client → le contexte RAG (propre à ce client) est ajouté
→ le tout part vers Claude avec les tools pertinents.

## Stack

Node.js + TypeScript + Express · PostgreSQL + pgvector · Claude (Anthropic
SDK, tool use) · WhatsApp Business Cloud API · Google Calendar (OAuth2) ·
HubSpot · BullMQ/Redis (via node-cron pour les jobs planifiés) · Railway (hébergement)

## Démarrage complet en local (3 commandes)

Le projet a besoin de Postgres (avec pgvector) et Redis. Le plus simple :

```bash
docker compose up -d          # lance Postgres+pgvector et Redis
npm install
cp .env.example .env
```

Génère une vraie clé de chiffrement et colle-la dans `.env` (`ENCRYPTION_KEY`) :
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Puis :
```bash
npm run migrate        # crée les tables (+ extension pgvector)
npm run seed            # insère les 5 profils sectoriels par défaut
npm run dev              # démarre le serveur API sur http://localhost:3000
```

Dans un second terminal, le worker qui traite réellement les relances et
rappels de RDV (obligatoire, sinon ils restent en attente dans Redis) :
```bash
npm run worker
```

Dans un troisième terminal, expose ton webhook local avec ngrok pour le
tester avec de vrais messages Meta :
```bash
ngrok http 3000
```

Utilise l'URL ngrok (`https://xxxx.ngrok.app/webhook`) comme URL de callback
dans la config WhatsApp du tableau Meta for Developers.

## Interface d'onboarding (Next.js)

Le projet `admin-console/` (livré séparément) est une vraie interface Next.js
connectée aux routes `/admin/*` de ce backend — pas une maquette. Pour la
lancer :

```bash
cd admin-console
npm install
cp .env.example .env.local   # BACKEND_URL=http://localhost:3000, BACKEND_ADMIN_KEY=<ta valeur de ADMIN_API_KEY>
npm run dev                   # http://localhost:3001 (ou le port libre suivant)
```

Elle affiche la liste réelle des clients, charge les vrais profils sectoriels
depuis la base (`GET /admin/sector-profiles`), crée un client via
`POST /admin/clients`, et le bouton **Dupliquer** précharge le wizard avec
les vraies données d'un client existant (`GET /admin/clients/:id`). La clé
admin (`BACKEND_ADMIN_KEY`) reste strictement côté serveur Next.js (API
routes) — jamais envoyée au navigateur.

## Configuration Meta (WhatsApp Business)

1. Crée une app sur [developers.facebook.com](https://developers.facebook.com), ajoute le produit **WhatsApp**.
2. Dans **Configuration du webhook**, renseigne :
   - URL de callback : `https://<ton-domaine>/webhook`
   - Token de vérification : la valeur de `WHATSAPP_VERIFY_TOKEN` dans ton `.env`
   - Champs à écouter : `messages`
3. Récupère `WHATSAPP_ACCESS_TOKEN` (token permanent via un compte système) et
   `WHATSAPP_APP_SECRET` (Paramètres de l'app > Basique).
4. Pour chaque client onboardé, récupère son `whatsapp_phone_number_id`
   (numéro Business dédié) et renseigne-le à la création (`whatsapp_phone_number_id`).
5. Fais valider par Meta les templates utilisés hors fenêtre de 24h (rappel
   RDV, relance, newsletter) — Business Manager > Modèles de messages.

## Onboarder un nouveau client

**Option CLI (recommandée en local) :**
```bash
npm run onboard
```
Le script pose les questions (secteur, nom, numéro WhatsApp, horaires,
tarifs), crée le client, injecte une FAQ générique du secteur, et affiche la
checklist des étapes manuelles restantes (HubSpot, Calendar, templates Meta).

**Option API admin :**
```bash
curl -X POST https://<ton-domaine>/admin/clients \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "secteur": "restaurant",
    "nom_entreprise": "Chez Amara",
    "whatsapp_business_number": "+2250700000000",
    "whatsapp_phone_number_id": "1234567890",
    "variables_prompt": { "horaires": "Lun-Sam 11h-22h", "tarifs": "Menu du jour 3500 FCFA" }
  }'
```

**Onboarder un 6e secteur (non prévu par défaut) :**
Duplique la ligne la plus proche dans `sector_profiles` (SQL direct ou via
un futur endpoint `/admin/sector-profiles`), ajuste `template_system_prompt`,
`workflows_actifs`, `champs_rdv` et `ton_par_defaut` — aucun redéploiement de
code n'est nécessaire.

## Alimenter la base de connaissance (RAG)

```bash
tsx scripts/ingest-knowledge.ts <client_id> chemin/vers/faq.txt
```
Le fichier est découpé par paragraphes (ligne vide = séparateur), chaque
paragraphe devient un chunk avec son embedding, scopé au `client_id`. Peut
aussi se faire via `POST /admin/knowledge-base` sans redéploiement.

**Fournisseur d'embeddings** : Claude ne fournit pas d'API d'embeddings native
→ ce projet utilise Voyage AI (`VOYAGE_API_KEY`) par recommandation
d'Anthropic. Remplaçable par un autre fournisseur en éditant uniquement
`src/rag/embed.ts`.

## Déploiement (Railway)

Guide complet et pas-à-pas : [DEPLOYMENT.md](../DEPLOYMENT.md) (services,
variables, rôle Postgres applicatif, tests de fumée, dépannage). En résumé :

1. Crée un projet Railway, ajoute un service **PostgreSQL** (active `pgvector`
   via `CREATE EXTENSION vector;` — géré automatiquement par `npm run migrate`)
   et un service **Redis** (si tu remplaces node-cron par des jobs BullMQ).
2. Connecte ce repo, Railway détecte `npm run build` / `npm start`.
3. Renseigne toutes les variables de `.env.example` dans l'onglet Variables.
4. Une fois déployé, lance `npm run migrate && npm run seed` via le shell
   Railway (ou en post-deploy hook).
5. Mets à jour l'URL de callback webhook côté Meta avec ton domaine Railway.

## Sécurité & conformité

- **Isolation multi-tenant** : toute requête métier passe par `withTenant()`,
  qui pose `app.current_client_id` dans une transaction ; les policies RLS
  (`migrations/002`, `004`, `005`) l'appliquent au niveau base. `withAdmin()`
  est la seule échappatoire cross-tenant (routes `/admin`, lookups de
  propriété du worker) et ouvre les policies `admin_mode_*`.

  ⚠️ **Postgres ignore la RLS pour un superutilisateur.** Le rôle du
  `docker-compose` local en est un : la RLS n'y protège donc rien, et c'est
  normal. En production, le backend et le worker doivent se connecter avec un
  rôle applicatif dédié non-superutilisateur — procédure dans
  [DEPLOYMENT.md](../DEPLOYMENT.md) §5. `migrations/004_force_rls.sql` ajoute
  `FORCE ROW LEVEL SECURITY` pour couvrir aussi le cas où ce rôle est le
  propriétaire des tables.
- Signature Meta (`X-Hub-Signature-256`) vérifiée sur chaque webhook entrant.
- Toutes les clés API en variables d'environnement uniquement.
- Fenêtre de conversation WhatsApp de 24h respectée : passé ce délai, seuls
  les templates approuvés (`sendWhatsappTemplate`) sont utilisables.
- Suppression RGPD : `DELETE /admin/contacts/:id` (cascade sur toutes les
  tables liées).
- Rate limiting basique sur les endpoints publics (`src/server.ts`).

### Rotation de l'Admin API Key (R5)

Si `ADMIN_API_KEY` est compromise (ou à titre de sécurité régulière) :

1. **Générer une nouvelle clé** :
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Mettre à jour backend** `.env` :
   ```
   ADMIN_API_KEY=<nouvelle-clé>
   ```

3. **Mettre à jour admin-console** `.env.local` :
   ```
   BACKEND_ADMIN_KEY=<même-nouvelle-clé>
   ```

4. **Redéployer immédiatement** (backend + admin-console)

5. **Vérifier les clients créés suspects** :
   ```bash
   psql $DATABASE_URL -c "SELECT id, nom_entreprise, created_at FROM clients ORDER BY created_at DESC LIMIT 20;"
   ```
   Supprimer tout client créé par un tiers non autorisé :
   ```bash
   curl -X DELETE https://<ton-domaine>/admin/contacts/<contact_id> \
     -H "x-admin-key: $ADMIN_API_KEY"
   ```

## Tests

```bash
npm run test:unit   # aucune infrastructure requise
npm run test:e2e    # Postgres requis (docker compose up -d && npm run migrate && npm run seed)
npm test            # les deux
```

- **Unitaires** : résolution du bon profil sectoriel selon le client,
  vérification de signature webhook, parsing des messages entrants (texte +
  boutons), chiffrement AES-256-GCM.
- **E2E** (`tests/e2e.integration.test.ts`) : la chaîne réelle webhook signé →
  orchestrateur → RAG → boucle tool use → base, sur la vraie base locale.
  Anthropic, Graph API WhatsApp, Google Calendar, HubSpot, Resend/Slack et
  Voyage sont mockés : aucun appel réseau, aucun coût, aucun message envoyé.
  Couvre le SAV avec contexte RAG, la réservation (agenda + RDV en base), la
  qualification de lead (score + HubSpot + alerte), l'escalade et le gel de la
  conversation, le client suspendu, le repli R1 (429 Anthropic), le repli R2
  (agenda indisponible), le filtrage des tools par workflow sectoriel, et le
  rejet des webhooks mal signés.
- **RLS** (`tests/rls.integration.test.ts`) : bascule sur un rôle applicatif
  non-superutilisateur (`SET LOCAL ROLE`) pour vérifier l'isolation telle
  qu'elle s'appliquera en production — lecture et écriture cross-tenant
  bloquées, échappatoire `withAdmin` fonctionnelle.

Les suites d'intégration sont ignorées automatiquement (skip) si
`DATABASE_URL` n'est pas joignable, et nettoient les clients qu'elles créent.

## OAuth Google Calendar par client

Chaque client connecte son propre agenda via un flow OAuth2 dédié :

1. Depuis la checklist retournée à l'onboarding, ouvre dans un navigateur :
   `https://<ton-domaine>/oauth/google/start?client_id=<uuid_du_client>`
2. Le client (ou toi en son nom) choisit son compte Google et autorise l'accès.
3. Callback automatique sur `/oauth/google/callback` : les tokens (avec
   `refresh_token`, grâce à `access_type: offline`) sont stockés dans
   `clients.google_oauth_tokens`, et `google_calendar_id` est rempli avec
   l'agenda principal du compte.
4. `src/integrations/calendar.ts` récupère ces tokens à chaque appel et les
   rafraîchit automatiquement (écouteur `oauth2Client.on("tokens", ...)`
   dans `src/integrations/googleOAuth.ts`) — rien à faire manuellement ensuite.

Renseigne `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`
dans `.env`, et ajoute `<ton-domaine>/oauth/google/callback` comme URI de
redirection autorisée dans la console Google Cloud (API Calendar activée).

## Workers BullMQ (scaling multi-instances)

Les relances et rappels RDV ne tournent plus dans le process du serveur web
(qui se dupliquerait avec plusieurs instances) : le serveur planifie un scan
horaire dans Redis (`scheduleRecurringScans()`), et un **process worker
séparé** traite réellement les envois, avec déduplication garantie même à
plusieurs workers en parallèle :

```bash
npm run worker
```

En production (Railway), déploie ce worker comme un **second service** dans
le même projet (même repo, commande de démarrage `npm run worker`), branché
sur le même `DATABASE_URL` et `REDIS_URL` que le serveur web. Tu peux scaler
le nombre d'instances web et le nombre de workers indépendamment.

## Email d'escalade

`src/escalation/notify.ts` envoie désormais un vrai email via
[Resend](https://resend.com) en plus de Slack. Renseigne `RESEND_API_KEY`,
`ESCALATION_EMAIL_FROM` (domaine vérifié côté Resend) et
`ESCALATION_EMAIL_TO` dans `.env`. Si tu préfères SendGrid ou un autre
fournisseur, seule la fonction `sendEscalationEmail()` est à adapter — le
reste du système ne change pas.

## Chiffrement applicatif des champs sensibles

Les tokens OAuth Google (`clients.google_oauth_tokens`) sont chiffrés en
AES-256-GCM avant écriture en base (`src/utils/encryption.ts`), en plus du
chiffrement au repos fourni par Railway Postgres. La clé (`ENCRYPTION_KEY`,
32 octets en hex) doit être générée une seule fois et ne jamais changer une
fois des clients connectés (sinon leurs tokens stockés deviennent
indéchiffrables — il faudrait les reconnecter via `/oauth/google/start`).

## Ce qui reste à brancher pour une mise en production réelle

- Rafraîchissement du token HubSpot si tu passes d'un token privé statique à
  une vraie app OAuth HubSpot par client (actuellement un seul
  `HUBSPOT_ACCESS_TOKEN` global — suffisant pour démarrer, à faire évoluer
  si tu onboardes des clients avec des comptes HubSpot distincts).
- Authentification de l'interface `admin-console` elle-même (actuellement
  protégée uniquement par le réseau/déploiement — ajoute un middleware
  Next.js avec un login si elle devient accessible publiquement).
