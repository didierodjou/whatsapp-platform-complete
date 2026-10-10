# WhatsApp Agent Platform

Agent WhatsApp Business automatisé (SAV, qualification de leads, prise de
rendez-vous, relances, newsletters) propulsé par Claude, **multi-clients et
multi-secteurs** : onboarder une nouvelle entreprise prend quelques minutes et
ne demande aucune modification du code.

```
Message WhatsApp
   │
   ▼
webhook Meta (signature vérifiée)
   │
   ▼
résolution du client  ──► le numéro Business qui reçoit identifie l'entreprise
   │                       └─► son secteur fournit le template de prompt
   │                       └─► ses variables (horaires, tarifs…) le remplissent
   ▼
recherche RAG (pgvector, scopée au client)
   │
   ▼
Claude + tools (agenda, leads, escalade, désinscription)
   │
   ▼
réponse WhatsApp + historisation en base
```

## Composants

| Dossier | Rôle | Démarrage |
|---|---|---|
| [backend/](backend/) | API Express : webhook, orchestrateur, RAG, tools, routes `/admin` | `npm run dev` |
| [backend/](backend/) (worker) | Process BullMQ séparé : relances et rappels de RDV | `npm run worker` |
| [admin-console/](admin-console/) | Interface Next.js d'onboarding et de gestion des clients | `npm run dev` |

Stack : Node.js + TypeScript + Express · PostgreSQL + pgvector · Claude
(Anthropic SDK, tool use) · WhatsApp Business Cloud API · Google Calendar
(OAuth2 par client) · HubSpot · BullMQ/Redis · Voyage AI (embeddings) ·
Railway (hébergement).

## Architecture en 3 couches

| Couche | Contenu | Où |
|---|---|---|
| **CORE** | orchestrateur, tools, sécurité, webhook | `backend/src/` |
| **SECTEUR** | template de prompt + workflows actifs par secteur | table `sector_profiles` |
| **CLIENT** | nom, horaires, tarifs, agenda, CRM, base de connaissance | table `clients` |

Ajouter un secteur ou modifier le comportement d'un client se fait en base, pas
en code.

## Démarrage rapide

```bash
cd backend
docker compose up -d              # Postgres+pgvector, Redis
npm install && cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY, ADMIN_API_KEY
npm run migrate && npm run seed   # schéma + RLS + 5 profils sectoriels
npm run dev                       # terminal 1 — API
npm run worker                    # terminal 2 — relances / rappels
```

```bash
curl http://localhost:3000/health   # → {"statut":"ok"}
```

## Documentation

| Document | Pour |
|---|---|
| [backend/README.md](backend/README.md) | Détail technique du backend, sécurité, OAuth, rotation de clé |
| [LOCAL_TESTING.md](LOCAL_TESTING.md) | Tester en local avec de vrais messages WhatsApp (ngrok, Meta) |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Mise en production Railway, variables, rôle Postgres, tests de fumée |
| [CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md) | Brancher une nouvelle entreprise de bout en bout |
| [AGENTS.md](AGENTS.md) | Guide détaillé pour agents IA travaillant sur ce repo |
| [PROJECT_AUDIT.md](PROJECT_AUDIT.md) · [RISKS_MITIGATIONS.md](RISKS_MITIGATIONS.md) | Audit technique et registre des risques (R1–R6) |
| [ETAT_FINAL.md](ETAT_FINAL.md) | État de finalisation, ce qui est vérifié, ce qui reste |

## Tests

```bash
cd backend
npm run test:unit   # sans infrastructure
npm run test:e2e    # pipeline complet + isolation RLS (Postgres requis)
npm test            # les deux — 31 tests
```

Les tests E2E rejouent la chaîne réelle (webhook signé → orchestrateur → RAG →
boucle tool use → base) avec toutes les dépendances externes mockées : aucun
appel réseau, aucun coût, aucun message envoyé.

## Sécurité

- Isolation multi-tenant par `client_id` **et** Row-Level Security Postgres
  forcée (`migrations/004`, `005`) — vérifiée par
  `backend/tests/rls.integration.test.ts`. En production, le backend doit se
  connecter avec un rôle **non-superutilisateur** (voir
  [DEPLOYMENT.md §5](DEPLOYMENT.md)).
- Signature Meta `X-Hub-Signature-256` vérifiée sur chaque webhook.
- Tokens OAuth Google chiffrés en AES-256-GCM avant stockage.
- Routes `/admin/*` protégées par `ADMIN_API_KEY`.
- Suppression RGPD en cascade : `DELETE /admin/contacts/:id`.
