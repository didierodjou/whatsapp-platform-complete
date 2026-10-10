# Prompt de Build — Système Agent WhatsApp Business (prêt à intégrer)

> À coller dans un assistant de code (Claude Code, Cursor, etc.) pour générer le projet complet. Personnalise les `[[...]]` avant de lancer.

---

## CONTEXTE DU PROJET

Construis un système **multi-clients et multi-secteurs** d'agent WhatsApp Business automatisé. Le système doit gérer en autonomie : SAV client, qualification de prospects, prise de rendez-vous, relances commerciales, et diffusion de newsletters — via l'API WhatsApp Business, avec Claude comme moteur de conversation.

Point clé : le système ne doit **pas** être codé en dur pour un secteur unique. Chaque nouveau client (restaurant, boutique en ligne, agence immobilière, salle de sport, clinique dentaire, etc.) doit pouvoir être onboardé en **choisissant un profil sectoriel** dans une liste, en remplissant quelques variables (nom, coordonnées, base de connaissance), sans toucher au code.

Génère un projet **prêt à déployer**, avec code fonctionnel (pas de pseudo-code), tests de base, variables d'environnement, et documentation de déploiement.

---

## 1. STACK TECHNIQUE (définitive)

- **Backend** : Node.js + TypeScript + Express — SDK officiel Anthropic, SDK Google/HubSpot matures, un seul langage sur tout le projet
- **Base de données** : PostgreSQL + extension **pgvector** pour le RAG (pas de service séparé, un seul système à opérer)
- **LLM** : API Anthropic (Claude), modèle `claude-sonnet-4-6`, avec tool use
- **Messagerie** : API WhatsApp Business Cloud (Meta) via webhook
- **Agenda** : Google Calendar API (OAuth2, compatible avec la quasi-totalité des PME)
- **CRM** : HubSpot API (tier gratuit exploitable pour démarrer chaque nouveau client, propriétés personnalisées par secteur)
- **Hébergement** : Railway (déploiement simple, Postgres managé inclus, bon rapport prix/simplicité pour un produit multi-clients)
- **File d'attente / scheduler** : BullMQ + Redis (relances programmées, rappels de RDV) — Railway propose Redis managé aussi

**Pourquoi ce choix facilite les intégrations** : tout le pipeline (webhook → Claude → tools → Calendar/HubSpot) tourne dans un seul langage/runtime, avec des SDK officiels pour chaque service externe. Ça réduit la surface de bugs d'intégration et accélère l'onboarding d'un nouveau client (pas de changement d'archi, juste de configuration).

---

## 2. ARCHITECTURE GÉNÉRALE

```
[WhatsApp Cloud API] 
     ↕ webhook (réception/envoi messages)
[Serveur Backend]
     ├── Module Webhook (vérification signature Meta, parsing messages)
     ├── Module Orchestrateur (routing intention → workflow)
     ├── Module LLM (appel Claude avec system prompt + RAG + historique)
     ├── Module RAG (recherche vectorielle base de connaissance)
     ├── Module Intégrations (Calendar, CRM)
     ├── Module Scheduler (relances programmées, rappels RDV)
     └── Module Escalade (notification humaine : email/Slack)
[Base de données PostgreSQL]
     ├── conversations (historique par contact)
     ├── contacts (leads, statut, score)
     ├── rendez_vous
     ├── relances_programmees
     └── knowledge_base (si pas de vector store séparé)
```

---

## 3. SYSTÈME DE PROFILS SECTORIELS (multi-clients)

C'est le cœur de la réutilisabilité du produit. Au lieu d'un system prompt figé par déploiement, structure le système en **3 couches** :

```
Couche 1 — CORE (identique pour tous les clients)
  → orchestrateur, tools, sécurité, workflows génériques

Couche 2 — PROFIL SECTORIEL (un template par secteur, réutilisé entre clients)
  → terminologie métier, workflows activés/désactivés, questions de
    qualification type, champs de RDV spécifiques, ton par défaut

Couche 3 — CLIENT (propre à chaque entreprise)
  → nom, coordonnées, horaires, tarifs, FAQ, base de connaissance,
    templates WhatsApp approuvés, comptes CRM/Calendar connectés
```

### 3.1 Table `sector_profiles` (en base, éditable sans redéploiement)

```sql
sector_profiles (
  id, nom_secteur,               -- "restaurant", "immobilier", "salle_de_sport", ...
  workflows_actifs,               -- jsonb: {sav: true, qualification: true, rdv: true, relance: true, newsletter: true}
  questions_qualification,        -- jsonb: liste de questions type pour ce secteur
  champs_rdv,                     -- jsonb: ex. immobilier -> {bien, budget, type_recherche}; dentaire -> {motif, urgence}
  ton_par_defaut,                 -- ex: "chaleureux et rapide" (restaurant) vs "rassurant et précis" (dentaire)
  template_system_prompt,         -- prompt métier générique du secteur, avec variables {{...}} à remplir par client
  declencheurs_relance_defaut,    -- jsonb: règles de relance type pour ce secteur
  created_at
)
```

### 3.2 Table `clients` (une ligne par entreprise onboardée)

```sql
clients (
  id, sector_profile_id, nom_entreprise, whatsapp_business_number,
  variables_prompt,               -- jsonb: valeurs pour remplir le template ({{nom}}, {{horaires}}, {{tarifs}}...)
  hubspot_account_id, google_calendar_id,
  statut,                         -- actif / onboarding / suspendu
  created_at
)
```

### 3.3 Résolution du system prompt à l'exécution

À chaque conversation, le système :
1. Identifie le client via le numéro WhatsApp Business qui a reçu le message
2. Charge son `sector_profile` + ses `variables_prompt`
3. Injecte les variables dans le `template_system_prompt` du secteur
4. Ajoute le contexte RAG (base de connaissance propre au client, filtrée par `client_id`)
5. Envoie à Claude

Ainsi, **le même code** sert un restaurant et une clinique dentaire — seule la config change.

### 3.4 Profils sectoriels à générer par défaut

Génère un template de départ (fichier `sectors/*.json` ou seed SQL) pour chacun de ces 5 secteurs, réutilisable pour tes prochains clients :

| Secteur | Workflows prioritaires | Champs de qualification clés | Ton par défaut |
|---|---|---|---|
| Restaurant | SAV, RDV (réservation), relance | Nombre de couverts, date, allergies | Chaleureux, rapide |
| Boutique en ligne | SAV, relance (panier abandonné), newsletter | Produit recherché, budget | Dynamique, direct |
| Agence immobilière | Qualification, RDV (visite) | Type de bien, budget, zone, échéance | Professionnel, rassurant |
| Salle de sport | Qualification, RDV (essai gratuit), relance | Objectif fitness, disponibilités | Motivant, énergique |
| Clinique dentaire | SAV, RDV, relance (rappel suivi) | Motif, urgence, dernière visite | Rassurant, précis |

### 3.5 Onboarding d'un nouveau client (script à générer)

Crée un script CLI ou un endpoint admin `POST /admin/clients` qui :
1. Demande le secteur (parmi les profils existants, ou "autre" → duplique un profil proche à ajuster)
2. Demande les variables client (nom, horaires, tarifs, coordonnées, numéro WhatsApp Business)
3. Crée l'entrée `clients`
4. Ingère automatiquement une première base de connaissance minimale (FAQ générique du secteur, à compléter)
5. Retourne un checklist des étapes manuelles restantes (connexion HubSpot, connexion Calendar, validation des templates WhatsApp par Meta)

---

## 4. FONCTIONNALITÉS À IMPLÉMENTER

### 3.1 Webhook WhatsApp
- Endpoint `GET /webhook` : vérification du token Meta (hub.challenge)
- Endpoint `POST /webhook` : réception des messages entrants, vérification de la signature `X-Hub-Signature-256`
- Parser les types de messages : texte, bouton interactif, liste, image (accusé réception seulement)
- Envoi de messages sortants via l'API Graph (texte, boutons rapides, templates)

### 3.2 Orchestrateur de conversation
- Charger l'historique de conversation du contact (dernières N interactions, fenêtre de 24h WhatsApp)
- Détecter l'intention (SAV / lead / RDV / autre) — soit via un premier appel LLM classifieur, soit via function calling avec Claude
- Router vers le bon workflow (voir section 4)
- Gérer le statut de la conversation (`ouverte`, `escaladée`, `fermée`)

### 3.3 Intégration LLM (Claude)
- Utiliser l'API Anthropic avec :
  - Le system prompt métier (celui généré précédemment, injecté dynamiquement avec les infos de la base de connaissance pertinentes — RAG)
  - **Tool use / function calling** pour les actions structurées : `check_calendar_availability`, `book_appointment`, `create_lead`, `escalate_to_human`, `unsubscribe_contact`
  - Historique de conversation limité aux N derniers échanges (gestion du contexte)
- Implémenter le pattern : message entrant → retrieval RAG → appel Claude avec tools → exécution des tool calls → réponse formatée → envoi WhatsApp

### 3.4 RAG (base de connaissance)
- Script d'ingestion : découper les documents métier (FAQ, catalogue, tarifs) en chunks, générer les embeddings, stocker dans le vector store
- Fonction de recherche : requête utilisateur → top-k chunks pertinents → injection dans le prompt
- Endpoint admin pour mettre à jour la base de connaissance sans redéploiement

### 3.5 Prise de rendez-vous
- Tool `check_calendar_availability(date_range)` → retourne les créneaux libres via Calendar API
- Tool `book_appointment(contact, datetime, motif)` → crée l'événement + enregistre en base
- Job planifié : envoyer un rappel WhatsApp 24h avant chaque RDV

### 3.6 Qualification de leads
- Tool `create_lead(nom, besoin, budget, score, contact_pref)` → insère en base + push CRM (webhook ou API)
- Notification à l'équipe commerciale (email/Slack) quand un lead est qualifié "chaud"

### 3.7 Relances automatiques
- Table `relances_programmees` (contact_id, sujet, date_prevue, nombre_envoyees, statut)
- Job cron (toutes les heures) : vérifier les relances à envoyer, générer le message via Claude, envoyer, incrémenter le compteur
- Règle : stop automatique si `nombre_envoyees >= 2` ou si le contact a répondu `#STOP_RELANCE`

### 3.8 Newsletter / diffusion commerciale
- Endpoint admin `POST /broadcast` : envoyer un template WhatsApp approuvé à une liste de contacts opt-in
- Gestion des opt-out ("STOP") : mise à jour automatique du statut contact, exclusion des futurs envois

### 3.9 Escalade humaine
- Tool `escalate_to_human(resume, urgence)` → notification Slack/email avec lien vers la conversation + résumé
- Marquer la conversation comme `escaladée` pour suspendre les réponses automatiques jusqu'à intervention humaine

---

## 5. SCHÉMA DE BASE DE DONNÉES (à générer en migrations SQL)

```sql
sector_profiles (id, nom_secteur, workflows_actifs, questions_qualification,
                  champs_rdv, ton_par_defaut, template_system_prompt,
                  declencheurs_relance_defaut, created_at)

clients (id, sector_profile_id, nom_entreprise, whatsapp_business_number,
         variables_prompt, hubspot_account_id, google_calendar_id, statut, created_at)

contacts (id, client_id, whatsapp_number, nom, statut, opt_in_marketing, score_lead, created_at)
conversations (id, contact_id, role, contenu, timestamp, intention_detectee)
rendez_vous (id, contact_id, datetime, motif, statut, rappel_envoye)
relances_programmees (id, contact_id, sujet, date_prevue, nombre_envoyees, statut)
knowledge_base_chunks (id, client_id, contenu, embedding, source, updated_at)  -- pgvector, filtré par client
escalades (id, contact_id, resume, urgence, statut, created_at)
```

> Toutes les tables métier portent une référence directe ou indirecte à `client_id` pour garantir l'isolation des données entre clients (multi-tenant).

---

## 6. SÉCURITÉ ET CONFORMITÉ

- **Isolation multi-tenant** : chaque requête (retrieval RAG, lecture/écriture en base) doit être scopée par `client_id` ; aucune donnée ou conversation d'un client ne doit jamais apparaître dans le contexte d'un autre
- Vérifier systématiquement la signature Meta sur chaque webhook entrant
- Stocker les clés API (Anthropic, Meta, Calendar, CRM) uniquement en variables d'environnement, jamais en dur
- Respecter la fenêtre de conversation WhatsApp de 24h (utiliser des templates approuvés au-delà)
- Chiffrer les données personnelles sensibles en base
- Endpoint de suppression des données d'un contact sur demande (conformité RGPD)
- Rate limiting sur les endpoints publics

---

## 7. LIVRABLES ATTENDUS

1. Arborescence complète du projet avec code fonctionnel
2. Fichier `.env.example` avec toutes les variables nécessaires
3. Scripts de migration de base de données (incluant `sector_profiles` et `clients`)
4. **5 profils sectoriels pré-remplis** (restaurant, boutique en ligne, agence immobilière, salle de sport, clinique dentaire) en seed SQL ou JSON, prêts à être dupliqués pour un 6e secteur
5. Script/endpoint d'onboarding d'un nouveau client (choix du secteur + variables)
6. Script d'ingestion de la base de connaissance (RAG), scopé par client
7. `README.md` avec : installation, configuration Meta (WhatsApp Business), déploiement, comment tester en local (ngrok pour le webhook), **et comment onboarder un nouveau client/secteur**
8. Tests de base sur les workflows critiques (réception message, création RDV, escalade, résolution du bon profil sectoriel selon le numéro WhatsApp)

---

## 8. INSTRUCTIONS DE DÉMARRAGE POUR L'ASSISTANT DE CODE

Procède dans cet ordre :
1. Scaffold du projet (structure de dossiers, dépendances)
2. Base de données + migrations, y compris `sector_profiles` et `clients`
3. Seed des 5 profils sectoriels par défaut (section 3.4)
4. Webhook WhatsApp (réception + envoi de messages basiques, sans LLM) + résolution du client via le numéro WhatsApp Business
5. Intégration Claude avec tool use (workflows SAV et qualification d'abord), en chargeant dynamiquement le system prompt résolu (couche core + profil sectoriel + variables client)
6. RAG (ingestion + retrieval), scopé par `client_id`
7. Intégration Calendar (RDV)
8. Scheduler (relances + rappels)
9. Intégration CRM + notifications d'escalade
10. Endpoint broadcast/newsletter
11. Script/endpoint d'onboarding d'un nouveau client
12. README + tests

Toutes les décisions techniques sont déjà arbitrées dans ce prompt (stack, CRM, Calendar). Ne pose une question que si un choix bloquant reste réellement ambigu ; sinon prends la décision la plus pragmatique et documente-la dans le README.
