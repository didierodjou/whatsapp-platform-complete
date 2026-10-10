# Tester en local avec de vrais messages WhatsApp

Objectif : recevoir un vrai message envoyé depuis ton téléphone, le faire
traiter par le pipeline complet tournant sur ta machine, et recevoir la
réponse de l'agent — avant tout déploiement.

Principe : Meta doit pouvoir appeler ton `localhost` en HTTPS, d'où **ngrok**
qui expose un tunnel public vers ton port local.

---

## 1. Démarrer l'infrastructure locale

```bash
cd backend
docker compose up -d          # Postgres+pgvector (port 5433) et Redis (6379)
docker ps                     # 2 conteneurs "Up" attendus
```

Première fois seulement :
```bash
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → ADMIN_API_KEY
npm run migrate               # crée les tables + pgvector + policies RLS
npm run seed                  # 5 profils sectoriels
```

Vérification :
```bash
psql postgres://whatsapp_agent:whatsapp_agent@localhost:5433/whatsapp_agent \
  -c "SELECT nom_secteur FROM sector_profiles;"
# → restaurant, boutique, immobilier, sport, dentaire
```

---

## 2. Lancer les trois services (trois terminaux)

```bash
# Terminal 1 — API
cd backend && npm run dev
# → "Serveur démarré sur le port 3000"

# Terminal 2 — worker (relances + rappels RDV)
cd backend && npm run worker
# → "Workers BullMQ démarrés (relances, rappels-rdv)."

# Terminal 3 — admin console (optionnel)
cd admin-console && npm run dev
# → http://localhost:3001
```

Contrôle rapide :
```bash
curl http://localhost:3000/health
# → {"statut":"ok"}

curl -H "x-admin-key: $ADMIN_API_KEY" http://localhost:3000/admin/worker-health
# → {"status":"✅ ok", ...}
```

> Le port du backend suit `PORT` dans `.env` (3000 par défaut). Adapte les URLs
> ci-dessous si tu l'as changé.

---

## 3. Exposer le webhook avec ngrok

```bash
# Terminal 4
ngrok http 3000
```

ngrok affiche une URL du type `https://abcd-12-34-56-78.ngrok-free.app`.
Elle **change à chaque redémarrage** de ngrok (sauf domaine réservé).

Dans **Meta for Developers → ton app → WhatsApp → Configuration** :

| Champ | Valeur |
|---|---|
| URL de rappel | `https://<ton-url-ngrok>/webhook` |
| Token de vérification | la valeur de `WHATSAPP_VERIFY_TOKEN` de ton `.env` |
| Champs abonnés | `messages` |

Clique **Vérifier et enregistrer** : Meta appelle `GET /webhook` et attend le
`hub.challenge` en retour. Si ça échoue, teste toi-même :

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=<TON_TOKEN>&hub.challenge=ping"
# → ping   (sinon : token différent entre .env et Meta)
```

---

## 4. Créer le client correspondant à ton numéro de test

Le numéro WhatsApp Business qui **reçoit** le message identifie le client. S'il
n'existe aucune ligne `clients` avec ce numéro, le message est ignoré (log
`Aucun client trouvé pour le numéro WhatsApp ...`).

```bash
cd backend && npm run onboard
```

Renseigne le numéro **exactement** au format renvoyé par Meta dans
`display_phone_number` (ex. `+33612345678`), et le Phone Number ID Meta —
sans lui, l'agent ne peut pas répondre. Détails :
[CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md).

---

## 5. Envoyer un vrai message

Depuis ton téléphone, écris au numéro WhatsApp Business de test (ex.
« Bonjour, quels sont vos horaires ? »).

Ce que tu dois observer, dans l'ordre :

1. **Inspecteur ngrok** — <http://127.0.0.1:4040> : un `POST /webhook` en 200,
   avec le JSON Meta complet (utile pour rejouer une requête à l'identique).
2. **Terminal 1** : aucune erreur ; en cas de souci les logs sont préfixés
   `Claude conversation error:` / `Erreur traitement webhook WhatsApp:`.
3. **Ton téléphone** : la réponse de l'agent, en 2–5 s.
4. **La base** :

```bash
psql postgres://whatsapp_agent:whatsapp_agent@localhost:5433/whatsapp_agent -c "
  SELECT cv.role, left(cv.contenu, 70) AS extrait, cv.timestamp
  FROM conversations cv ORDER BY cv.timestamp DESC LIMIT 6;"
```

Deux lignes par échange : `user` puis `assistant`.

---

## 6. Tester sans téléphone (rejouer un webhook signé)

Pratique pour itérer vite, ou tester un scénario précis sans consommer de
messages Meta. La signature doit être calculée sur le corps **brut** avec
`WHATSAPP_APP_SECRET`, sinon la requête est rejetée en 401.

```bash
APP_SECRET="<WHATSAPP_APP_SECRET>"
BODY='{"entry":[{"changes":[{"value":{
  "metadata":{"phone_number_id":"<PHONE_NUMBER_ID>","display_phone_number":"<NUMERO_BUSINESS>"},
  "messages":[{"from":"<TON_NUMERO_PERSO>","type":"text","text":{"body":"Quels sont vos horaires ?"}}]
}}]}]}'

SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" -r | cut -d' ' -f1)"

curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: $SIG" \
  -d "$BODY"
# → 200 (Meta est acquitté immédiatement ; le traitement se poursuit en tâche de fond)
```

`<NUMERO_BUSINESS>` doit correspondre au `whatsapp_business_number` d'un client
existant. L'appel Graph API d'envoi partira réellement : pour t'en abstenir,
utilise plutôt la suite E2E ci-dessous.

---

## 7. Suite de tests automatisés

```bash
cd backend
npm run test:unit   # signature webhook, chiffrement, résolution de prompt — sans infra
npm run test:e2e    # pipeline complet + isolation RLS — nécessite Postgres
npm test            # tout
```

Les tests E2E rejouent webhook → orchestrateur → RAG → boucle tool use → base
sur la vraie base locale, avec Anthropic / Graph API / Google / HubSpot / Voyage
mockés : aucun appel réseau, aucun coût, aucun message envoyé. Ils créent puis
suppriment leurs propres clients (numéros `+339200000xx` / `+339000000xx`) et
sont ignorés automatiquement si Postgres n'est pas joignable.

---

## 8. Dépannage

| Symptôme | Piste |
|---|---|
| Meta refuse d'enregistrer le webhook | Token différent des deux côtés, ou ngrok arrêté |
| `POST /webhook` en 401 dans l'inspecteur ngrok | `WHATSAPP_APP_SECRET` erroné, ou corps modifié par un proxy |
| 200 mais rien dans les logs | Aucun client sur ce `display_phone_number` — compare `SELECT whatsapp_business_number FROM clients;` |
| Réponse générée mais jamais reçue | `whatsapp_phone_number_id` manquant ou `WHATSAPP_ACCESS_TOKEN` expiré |
| Réponses génériques, sans les infos du client | Base de connaissance vide ou `VOYAGE_API_KEY` absente — voir [CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md) |
| « Je suis temporairement surchargé » | Repli R1 : quota Anthropic (429) ou clé invalide |
| Contact qui ne reçoit plus rien | Conversation escaladée : `SELECT statut FROM contacts WHERE whatsapp_number = '...';` → remettre à `'ouvert'` |
| Relances jamais parties | Le worker (terminal 2) n'est pas lancé |
| ngrok redémarré | Nouvelle URL → remettre à jour l'URL de rappel côté Meta |
