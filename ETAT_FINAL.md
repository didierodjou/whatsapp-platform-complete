# État de finalisation

**Date** : 2026-09-03
**Portée** : exécution des phases 2 à 5 de [EXECUTION_PLAN.md](EXECUTION_PLAN.md)
**Verdict** : code prêt pour la mise en production. Ce qui reste dépend d'accès
externes (Railway, Meta, comptes clients) et non du code.

---

## 1. Ce qui a été vérifié sur cette machine

| Contrôle | Commande | Résultat |
|---|---|---|
| Compilation TypeScript | `npx tsc --noEmit` | ✅ aucune erreur |
| Build backend | `npm run build` | ✅ |
| Build admin-console | `npm run build` (Next 14) | ✅ 5 routes générées |
| Tests | `npm test` | ✅ **31 tests / 5 fichiers** |
| Migrations | `npm run migrate` | ✅ 001 → 005 appliquées |
| Seed idempotent | `npm run seed` ×2 | ✅ toujours 5 profils sectoriels |
| Démarrage API | `npm run dev` | ✅ port 3001 |
| Démarrage worker | `npm run worker` | ✅ « Workers BullMQ démarrés » |
| `GET /health` | curl | ✅ `{"statut":"ok"}` |
| `GET /admin/worker-health` | curl + clé | ✅ `status: ✅ ok`, 0 job en attente |
| `/admin/*` sans clé | curl | ✅ 401 |
| `POST /webhook` non signé | curl | ✅ 401 |
| `GET /webhook` (vérification Meta) | curl | ✅ renvoie le `hub.challenge` |

---

## 2. Risques R1–R6 : tous traités

| # | Risque | État | Où |
|---|---|---|---|
| R1 | Timeout / 429 Claude sans repli | ✅ | `src/llm/converse.ts` — testé E2E |
| R2 | Expiration des tokens Google → échec silencieux | ✅ | `src/integrations/calendar.ts` + `executeTool.ts` — testé E2E |
| R3 | Audit de l'isolation multi-tenant | ✅ **corrigé** | voir §3 — la RLS était inerte |
| R4 | Vérification de signature webhook non testée | ✅ | `tests/whatsapp.test.ts` + E2E HTTP |
| R5 | Rotation de `ADMIN_API_KEY` non documentée | ✅ | `backend/README.md` |
| R6 | Worker arrêté sans alerte | ✅ | `GET /admin/worker-health` |

---

## 3. Trois défauts trouvés et corrigés pendant la finalisation

### 3.1 L'isolation multi-tenant par RLS ne s'appliquait pas (sécurité)

`migrations/002_rls.sql` active la RLS, mais **Postgres n'applique aucune policy
au propriétaire des tables** sans `FORCE ROW LEVEL SECURITY`. L'application se
connectant avec ce rôle, les policies étaient intégralement contournées :
l'isolation ne reposait que sur les `WHERE client_id = ...` applicatifs. Les
audits précédents la comptaient pourtant comme « ✅ 100 % ».

- `migrations/004_force_rls.sql` : `FORCE ROW LEVEL SECURITY` sur les 6 tables
  métier, plus des policies `admin_mode_*` pour les accès cross-tenant
  légitimes.
- `src/db/pool.ts` : nouveau helper `withAdmin()`, seule échappatoire explicite.
- `src/admin/routes.ts` et `src/scheduler/worker.ts` : les trois lookups
  cross-tenant qui auraient silencieusement renvoyé 0 ligne sous RLS effective
  sont corrigés (suppression RGPD, envoi de relance, envoi de rappel). Les jobs
  BullMQ transportent désormais leur `clientId`.
- `tests/rls.integration.test.ts` : bascule sur un rôle non-superutilisateur
  pour vérifier l'isolation telle qu'elle s'appliquera en production.

> ⚠️ **Action requise au déploiement** : en production, le backend et le worker
> doivent se connecter avec un rôle Postgres **non-superutilisateur**
> (l'utilisateur `postgres` par défaut de Railway en est un et contourne la RLS
> quoi qu'il arrive). Procédure : [DEPLOYMENT.md §5](DEPLOYMENT.md).

### 3.2 Requêtes en erreur sur connexion recyclée du pool (bug de production)

Les policies de 002 castaient `current_setting('app.current_client_id', true)::uuid`.
Après une transaction `withTenant`, ce paramètre ne retombe pas à `NULL` mais à
la **chaîne vide** ; sur une connexion réutilisée par le pool, la policy évaluait
`''::uuid` et levait `invalid input syntax for type uuid: ""` — cassant la
requête au lieu de simplement ne rien renvoyer. Trouvé par le test RLS.
Corrigé par `migrations/005_rls_nullif.sql` (`nullif(..., '')`).

### 3.3 Le seed n'était pas idempotent (blocage de déploiement)

`seeds/sector_profiles.sql` n'avait pas de `ON CONFLICT` : la commande
pre-deploy recommandée (`npm run migrate && npm run seed`) aurait échoué sur
la contrainte unique `nom_secteur` à **chaque redéploiement après le premier**.
Corrigé (`ON CONFLICT (nom_secteur) DO NOTHING`), vérifié en lançant le seed
deux fois de suite.

---

## 4. Tests livrés (Phase 3)

**31 tests**, dont 19 nouveaux.

`backend/tests/e2e.integration.test.ts` — 13 tests parcourant la vraie chaîne
webhook signé → orchestrateur → RAG → boucle tool use → base, sur la base
Postgres locale, avec Anthropic / Graph API / Google / HubSpot / Resend / Voyage
mockés (aucun appel réseau, aucun coût, aucun message envoyé) :

- SAV avec contexte RAG scopé au bon client + historisation des deux tours
- Réservation : `check_calendar_availability` → `book_appointment` → RDV en base
  avec l'ID d'événement Google
- Repli R2 : agenda indisponible → erreur exploitable par Claude, réponse envoyée
- Qualification : `create_lead` → score en base, push HubSpot, alerte lead chaud
- Escalade : ouverture d'escalade, gel du contact, message suivant non automatisé
- Client suspendu et numéro Business inconnu : aucun traitement
- Repli R1 : 429 Anthropic → message de repli envoyé et historisé
- Filtrage des tools selon les workflows du secteur
- Isolation des historiques entre deux clients pour un même numéro de contact
- Webhook HTTP : `hub.challenge`, traitement complet après 200, rejet en 401
  d'une signature invalide ou absente

`backend/tests/rls.integration.test.ts` — 6 tests d'isolation base (§3.1).

Les suites d'intégration sont ignorées automatiquement si `DATABASE_URL` n'est
pas joignable, et nettoient les clients qu'elles créent.
Nouveaux scripts : `npm run test:unit` (sans infra) et `npm run test:e2e`.

---

## 5. Documentation livrée (Phase 4)

| Fichier | Contenu |
|---|---|
| [README.md](README.md) | Point d'entrée du dépôt (il n'en existait pas à la racine) |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Railway pas-à-pas, 3 services, rôle Postgres applicatif, checklist des variables, 6 tests de fumée, tableau de dépannage |
| [LOCAL_TESTING.md](LOCAL_TESTING.md) | ngrok + Meta, 3 terminaux, rejeu d'un webhook signé sans téléphone, dépannage |
| [CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md) | Les 7 étapes d'un client, OAuth Calendar, HubSpot, ingestion RAG, recette, exploitation courante |
| `backend/README.md` | Sections Tests et Sécurité mises à jour (RLS, `withAdmin`, rôle non-superutilisateur) |

---

## 6. Ce qui reste — hors de portée du code

Ces points demandent des accès que je n'ai pas ; ils sont documentés pas-à-pas.

1. **Déployer sur Railway** — [DEPLOYMENT.md](DEPLOYMENT.md) §1-4.
2. **Créer le rôle Postgres applicatif** non-superutilisateur — §5. Sans lui, la
   RLS reste contournée en production.
3. **Mettre à jour les URLs externes** : callback webhook Meta, URI de
   redirection Google OAuth — §7.
4. **Faire valider les templates WhatsApp** par Meta (24-48 h de délai côté
   Meta) — nécessaire aux relances, rappels et newsletters.
5. **Onboarder un client pilote** et jouer la recette bout en bout —
   [CLIENT_ONBOARDING.md](CLIENT_ONBOARDING.md) §7.
6. **Sauvegardes et supervision** : backups automatiques Postgres, check externe
   sur `/health`, surveillance de `/admin/worker-health` — §10.

---

## 7. Limites connues assumées pour le MVP

Aucune n'est bloquante ; elles sont listées pour ne pas être découvertes en
production.

- **L'admin-console n'a pas d'authentification propre** : ne pas lui donner de
  domaine public en l'état (rappelé dans DEPLOYMENT.md §4).
- **Pas de journal d'audit ni de suppression logique** : la suppression RGPD est
  définitive et non tracée.
- **Rate limiting global** (120 req/min/IP, en mémoire) : ni par client, ni
  partagé entre instances.
- **HubSpot mono-compte** : un seul `HUBSPOT_ACCESS_TOKEN` global ; le
  `hubspot_account_id` par client ne fait qu'activer la remontée.
- **Webhook texte, boutons et listes uniquement** : les images ne reçoivent
  qu'un accusé de réception, audio/documents/localisation ne sont pas traités.
- **`variables_prompt` est remplacé en entier** par un `PATCH`, jamais fusionné.
- **Modèle Claude** : `claude-sonnet-4-6` est configuré et valide. `claude-sonnet-5`
  (plus récent, et moins cher : 2 $/10 $ par MTok contre 3 $/15 $) ou
  `claude-opus-5` pour plus de capacité sont des alternatives possibles — un
  simple changement de `ANTHROPIC_MODEL`, à évaluer sur des conversations
  réelles avant de basculer.
- **Cosmétique** : `backend/.env` contient trois lignes sans `=` (une URL Make,
  un token) que dotenv ignore silencieusement — sans effet, mais à nettoyer.
