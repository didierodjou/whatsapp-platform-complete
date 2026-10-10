# Onboarder un nouveau client — pas-à-pas

Objectif : passer d'une entreprise cliente signée à un agent WhatsApp
opérationnel, **sans toucher au code**. Compte 20–30 min par client, dont
l'essentiel en attente de validations externes (templates Meta).

Rappel du modèle : le numéro WhatsApp Business qui reçoit un message identifie
le client → son secteur fournit le template de prompt → les variables du client
le remplissent → sa base de connaissance fournit le contexte RAG.

---

## Vue d'ensemble

| # | Étape | Bloquant pour… | Durée |
|---|---|---|---|
| 1 | Créer le client (CLI ou console) | tout | 2 min |
| 2 | Renseigner le Phone Number ID Meta | l'envoi des réponses | 5 min |
| 3 | Charger la base de connaissance | la qualité des réponses | 10 min |
| 4 | Connecter Google Calendar | les prises de RDV | 3 min |
| 5 | Connecter HubSpot | la remontée des leads | 5 min |
| 6 | Faire valider les templates Meta | relances / rappels / newsletter | 24–48 h (Meta) |
| 7 | Recette bout en bout | mise en service | 5 min |

Les étapes 4 à 6 ne concernent que les workflows actifs du secteur (un
restaurant n'a pas de qualification de leads, une boutique n'a pas de RDV).

---

## 1. Créer le client

### Option A — CLI (la plus rapide)

```bash
cd backend
npm run onboard
```

Le script demande : secteur, nom d'entreprise, numéro WhatsApp Business, Phone
Number ID Meta, horaires, tarifs. Il crée le client, injecte une FAQ générique
du secteur, puis affiche l'ID et la checklist restante :

```
Client créé avec succès.
ID: 8f3c1e2a-...

Checklist restante :
  [ ] Connecter le compte HubSpot (renseigner hubspot_account_id)
  [ ] Connecter Google Calendar : https://<domaine>/oauth/google/start?client_id=8f3c1e2a-...
  [ ] Faire valider les templates WhatsApp (rappel RDV, relance, newsletter) par Meta
  [ ] Compléter la base de connaissance au-delà de la FAQ générique injectée
  [ ] Renseigner whatsapp_phone_number_id si non fourni à la création
```

Note l'ID : il sert à toutes les étapes suivantes.

### Option B — Admin console

Ouvre l'admin console → **Nouveau client**. Le wizard en 4 écrans : profil
sectoriel → identité (nom, horaires, tarifs) → numéro WhatsApp Business +
Phone Number ID → récapitulatif.

Le bouton **Dupliquer** sur un client existant préremplit le wizard avec sa
configuration réelle : pratique pour onboarder plusieurs clients d'un même
secteur.

### Option C — API admin

```bash
curl -X POST https://<domaine-backend>/admin/clients \
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

Secteurs disponibles : `restaurant`, `boutique`, `immobilier`, `sport`,
`dentaire`. Pour un 6ᵉ secteur, duplique la ligne la plus proche dans
`sector_profiles` et ajuste `template_system_prompt`, `workflows_actifs`,
`champs_rdv`, `ton_par_defaut` — aucun redéploiement n'est nécessaire.

> ⚠️ `whatsapp_business_number` doit être **exactement** le
> `display_phone_number` envoyé par Meta dans le webhook (format `+22507...`).
> Une différence d'espace ou d'indicatif et les messages sont ignorés
> silencieusement.

---

## 2. Renseigner le Phone Number ID Meta

Sans lui, l'agent comprend les messages mais ne peut pas répondre (l'appel Graph
API est adressé à cet identifiant).

Meta for Developers → ton app → **WhatsApp → Configuration de l'API** →
*Phone number ID* (une suite de chiffres, différente du numéro affiché).

```bash
curl -X PATCH https://<domaine-backend>/admin/clients/<client_id> \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"whatsapp_phone_number_id": "1234567890"}'
```

---

## 3. Charger la base de connaissance (RAG)

C'est l'étape qui fait la différence entre un agent générique et un agent qui
connaît réellement l'entreprise. Le prompt interdit d'inventer : tout ce qui
n'est ni dans les variables du client ni dans la base de connaissance ne sera
pas répondu.

Prépare un fichier texte, **un paragraphe par information** (une ligne vide
sépare deux chunks) :

```text
Le restaurant Chez Amara propose une cuisine ivoirienne traditionnelle et des plats du jour.

Nous sommes ouverts du lundi au samedi, de 11h à 22h. Fermé le dimanche.

Menu du jour : 3500 FCFA (plat + boisson). Menu découverte : 8000 FCFA.

Les réservations de plus de 8 couverts nécessitent un acompte de 50%.

Nous disposons d'une salle privatisable de 30 places à l'étage.
```

Ingestion :
```bash
cd backend
npm run ingest -- <client_id> chemin/vers/faq.txt
```

Ou sans passer par le CLI (mise à jour à chaud, sans redéploiement) :
```bash
curl -X POST https://<domaine-backend>/admin/knowledge-base \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"<client_id>","chunks":[{"contenu":"Menu du jour : 3500 FCFA.","source":"menu_2026"}]}'
```

Vérification :
```bash
psql $DATABASE_URL -c "SELECT source, left(contenu,50) FROM knowledge_base_chunks WHERE client_id='<client_id>';"
```

> `VOYAGE_API_KEY` est obligatoire ici : sans elle, aucun embedding n'est
> calculé et l'ingestion échoue (à la création du client, la FAQ générique est
> alors ignorée avec un simple avertissement dans les logs).

---

## 4. Connecter Google Calendar (workflows RDV)

À faire uniquement si le secteur a `workflows_actifs.rdv = true`
(restaurant, immobilier, sport, dentaire).

1. Ouvre dans un navigateur — idéalement avec le client, sur **son** compte
   Google :
   ```
   https://<domaine-backend>/oauth/google/start?client_id=<client_id>
   ```
2. Écran de consentement Google → autoriser l'accès à l'agenda.
3. Redirection automatique vers `/oauth/google/callback` : les tokens (avec
   `refresh_token`) sont chiffrés en AES-256-GCM puis stockés, et
   `google_calendar_id` est renseigné avec l'agenda principal du compte.

Vérification :
```bash
curl -H "x-admin-key: $ADMIN_API_KEY" https://<domaine-backend>/admin/clients/<client_id>
# → "calendarConnecte": true
```

Le rafraîchissement du token est automatique ensuite. Si la connexion est
révoquée côté Google, les demandes de disponibilité répondent « Calendrier
temporairement indisponible… » (repli R2) et il faut refaire cette étape.

---

## 5. Connecter HubSpot (workflows qualification)

À faire si le secteur a `workflows_actifs.qualification = true` (immobilier,
sport…). Le token HubSpot est aujourd'hui **global** (`HUBSPOT_ACCESS_TOKEN`) ;
le client, lui, doit porter un `hubspot_account_id` pour que la remontée
s'active.

```sql
UPDATE clients SET hubspot_account_id = '<portal_id_hubspot>' WHERE id = '<client_id>';
```

Propriétés personnalisées à créer une fois dans le compte HubSpot (Paramètres →
Propriétés → Contacts) : `besoin_exprime`, `budget_indicatif`,
`score_qualification`, `canal_source`.

Sans `hubspot_account_id`, les leads restent enregistrés en base (`score_lead`
sur le contact) et un avertissement est loggé — rien n'est perdu.

---

## 6. Faire valider les templates WhatsApp

Passé 24 h sans message du contact, Meta n'autorise plus que des **templates
approuvés**. Ils sont nécessaires aux relances, aux rappels de RDV et aux
newsletters (le SAV en direct, lui, ne les utilise pas).

Business Manager → **Modèles de messages** → créer, en français, au minimum :

| Usage | Nom suggéré | Catégorie |
|---|---|---|
| Rappel de RDV (J-1) | `rappel_rdv` | Utility |
| Relance commerciale | `relance_commerciale` | Marketing |
| Newsletter / diffusion | `newsletter_mensuelle` | Marketing |

Validation Meta : quelques minutes à 48 h. Les diffusions se déclenchent ensuite
par `POST /admin/broadcast` avec `template_name`, et n'atteignent que les
contacts `opt_in_marketing = true`.

---

## 7. Recette bout en bout

```bash
# Le client est bien résolu et configuré
curl -H "x-admin-key: $ADMIN_API_KEY" https://<domaine-backend>/admin/clients/<client_id>
# → statut, calendarConnecte, hubspotConnecte, whatsappPhoneNumberId
```

Depuis un téléphone, écris au numéro WhatsApp Business du client :

| Test | Message | Attendu |
|---|---|---|
| SAV / RAG | « Quels sont vos horaires ? » | Réponse reprenant les horaires **du client**, pas une généralité |
| Connaissance métier | Une question dont la réponse est dans la FAQ ingérée | L'information exacte (prix, conditions) |
| RDV (si actif) | « Je voudrais réserver pour 4 demain 19h » | Créneau proposé, confirmation, événement créé dans l'agenda Google |
| Lead (si actif) | « Je cherche un 3 pièces, budget 400k, sous 2 mois » | Contact avec `score_lead` renseigné, remontée HubSpot |
| Escalade | Une réclamation grave | Notification Slack/email, contact passé en `escalade` |

Contrôle en base :
```bash
psql $DATABASE_URL -c "
  SELECT c.whatsapp_number, c.statut, c.score_lead, count(cv.id) AS messages
  FROM contacts c LEFT JOIN conversations cv ON cv.contact_id = c.id
  WHERE c.client_id = '<client_id>' GROUP BY 1,2,3;"
```

Une fois la recette passée, bascule le client en production :
```bash
curl -X PATCH https://<domaine-backend>/admin/clients/<client_id> \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"statut": "actif"}'
```

Statuts : `onboarding` et `actif` sont traités normalement ; `suspendu` coupe
toute automatisation pour ce client.

---

## Exploitation courante

**Modifier les informations d'un client** (horaires, tarifs, secteur, statut) —
prise en compte immédiate, au message suivant :
```bash
curl -X PATCH https://<domaine-backend>/admin/clients/<client_id> \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"variables_prompt": {"horaires":"Lun-Dim 10h-23h","tarifs":"Menu du jour 4000 FCFA"}}'
```
> `variables_prompt` est **remplacé en entier**, pas fusionné : renvoie toutes
> les clés, pas seulement celles qui changent.

**Reprendre une conversation escaladée** (après traitement humain) :
```sql
UPDATE contacts SET statut = 'ouvert' WHERE id = '<contact_id>';
```

**Suppression RGPD** d'un contact et de tout son historique :
```bash
curl -X DELETE https://<domaine-backend>/admin/contacts/<contact_id> \
  -H "x-admin-key: $ADMIN_API_KEY"
```

---

## Problèmes fréquents

| Symptôme | Cause | Correction |
|---|---|---|
| Aucune réaction aux messages | `whatsapp_business_number` ≠ `display_phone_number` Meta | Corriger le numéro sur le client |
| « Je transmets votre demande à un membre de l'équipe » systématique | Boucle de tools épuisée (4 tours) — souvent une info manquante | Compléter la base de connaissance / les variables |
| Réponses vagues | Base de connaissance vide ou trop générique | Ingérer une vraie FAQ (étape 3) |
| Les RDV ne se créent pas | Calendar non connecté ou OAuth révoqué | Refaire l'étape 4 |
| Leads absents de HubSpot | `hubspot_account_id` non renseigné | Étape 5 |
| Relances jamais envoyées | Service worker arrêté, ou contact `opt_in_marketing = false` | `GET /admin/worker-health` |
| Un contact reçoit deux fois la même relance | Normal jusqu'à 2 envois (`MAX_RELANCES`), espacés de 48 h | — |
