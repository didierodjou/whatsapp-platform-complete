# Agent WhatsApp Platform — AI Coding Guide

> Multi-tenant WhatsApp Business automation platform powered by Claude, designed for instant client onboarding without code changes.

## Project Overview

**What it does**: Automates customer service, lead qualification, appointment booking, reminders, and newsletters for businesses via WhatsApp, driven by Claude's tool use and RAG context.

**Architecture**: 3-layer pyramid
- **Layer 1 (Core)**: Orchestrator, tools, security, webhooks (`src/`)
- **Layer 2 (Sectors)**: Shared templates & workflows per sector type (restaurant, boutique, immobilier, sport, dentaire)
- **Layer 3 (Clients)**: Company-specific config: name, hours, pricing, calendar, CRM

**Message flow**: WhatsApp Business number → identifies client → loads sector profile → fills with client variables → retrieves RAG context → sends to Claude with tools → response sent back.

## Technology Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Backend API | Node.js 20+ / TypeScript / Express | `src/` main entry |
| Frontend (Admin) | Next.js 14 / React 18 / Tailwind | Separate repo in `admin-console/` |
| Database | PostgreSQL 15+ with pgvector | Multi-tenant with Row-Level Security (RLS) |
| Cache/Queues | Redis 7+ via BullMQ | Scheduled tasks (reminders, follow-ups) |
| AI | Claude (Anthropic SDK) | Tool use for calendar, leads, CRM |
| Integrations | WhatsApp Business Cloud API, Google Calendar (OAuth2), HubSpot | See `.env.example` for config |
| Hosting | Railway (or any Docker-compatible PaaS) | |

## Project Structure

```
backend/                    # Main Express API + orchestrator
├── src/
│   ├── server.ts          # Express app, routes, rate limiting
│   ├── orchestrator/      # Message handling pipeline
│   │   ├── handleIncomingMessage.ts  # Main entry for WhatsApp messages
│   │   └── resolveClient.ts          # Client lookup + system prompt builder
│   ├── llm/               # Claude integration
│   │   ├── converse.ts    # Chat loop with tool use
│   │   ├── tools.ts       # Tool schemas (calendar, leads, etc.)
│   │   └── executeTool.ts # Tool execution logic
│   ├── db/
│   │   └── pool.ts        # PostgreSQL connection + withTenant() helper
│   ├── rag/               # Vector search & context retrieval
│   │   ├── embed.ts       # Encode documents to vectors (Voyage API)
│   │   └── retrieve.ts    # Semantic search in pgvector
│   ├── integrations/      # External APIs
│   │   ├── whatsapp.ts    # Send messages via Meta Graph API
│   │   ├── googleOAuth.ts # Calendar OAuth flow
│   │   ├── calendar.ts    # Google Calendar read/write
│   │   ├── hubspot.ts     # CRM sync
│   ├── scheduler/         # Async jobs
│   │   ├── queues.ts      # BullMQ job definitions
│   │   └── worker.ts      # Background task processor (run separately)
│   ├── admin/             # Protected admin routes
│   │   └── routes.ts      # /admin/* endpoints for onboarding UI
│   ├── middleware/        # Auth & validation
│   │   └── adminAuth.ts   # API key verification
│   └── utils/             # Helpers
│       └── encryption.ts  # Sensitive field encryption/decryption
├── migrations/            # SQL schemas & extensions
│   ├── 001_init.sql       # Tables: sector_profiles, clients, contacts, messages, leads, etc.
│   ├── 002_rls.sql        # Row-Level Security policies (multi-tenant isolation)
│   └── 003_encrypt_sensitive_fields.sql
├── scripts/               # One-off utilities
│   ├── migrate.ts         # Run migrations
│   ├── seed.ts            # Load default sector profiles
│   ├── onboard-client.ts  # CLI for adding new business
│   └── ingest-knowledge.ts# Upload company docs → vectorize
└── tests/                 # Vitest

admin-console/            # Next.js 14 frontend
├── app/
│   ├── page.tsx          # Dashboard (client list + search)
│   ├── layout.tsx        # Root layout
│   └── api/
│       ├── clients/      # Proxy to backend /admin/clients
│       └── sectors/      # Proxy to backend /admin/sectors
├── components/
│   └── Wizard.tsx        # Multi-step client onboarding form
└── lib/
    ├── backend.ts        # Fetch helpers for API calls
    └── types.ts          # TypeScript types (ClientSummary, etc.)
```

## Essential Development Tasks

### 1. **First-Time Setup (3 commands)**

```bash
# Terminal 1: Start Docker containers (PostgreSQL + pgvector + Redis)
docker compose up -d

# Install dependencies
npm install

# Copy .env template
cp .env.example .env

# Generate encryption key and paste into .env (ENCRYPTION_KEY)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Run migrations & seed default sector profiles
npm run migrate
npm run seed

# Start backend server
npm run dev
```

```bash
# Terminal 2: Start background worker (MUST run separately)
npm run worker
```

```bash
# Terminal 3 (optional): Expose local server for WhatsApp testing
ngrok http 3000
# Copy ngrok URL to Meta dashboard webhook config
```

```bash
# Terminal 4: Start admin console
cd admin-console
npm install
cp .env.example .env.local
npm run dev
# Access at http://localhost:3001
```

### 2. **Environment Variables**

**Backend** (`.env`):
- `ANTHROPIC_API_KEY`: Claude API key
- `DATABASE_URL`: PostgreSQL connection
- `REDIS_URL`: Redis for BullMQ
- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`: Meta config
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Calendar OAuth
- `ADMIN_API_KEY`: Secret for admin endpoints
- `ENCRYPTION_KEY`: 64-char hex (for encrypting sensitive fields)

**Frontend** (`admin-console/.env.local`):
- `BACKEND_URL`: Points to backend (http://localhost:3000)
- `BACKEND_ADMIN_KEY`: Must match backend's `ADMIN_API_KEY` (stored server-side only)

### 3. **Onboarding a New Client**

Interactive CLI (recommended):
```bash
npm run onboard
```

Then create a Wizard entry in admin console, or call `POST /admin/clients`:
```json
{
  "nom_entreprise": "Restaurant XYZ",
  "sector_profile_id": "uuid-of-restaurant-profile",
  "whatsapp_business_number": "+33123456789",
  "whatsapp_phone_number_id": "meta-phone-id",
  "variables_prompt": { "horaires": "09h-18h", "specialites": "sushi, makis" }
}
```

### 4. **Adding Client Knowledge (RAG)**

Upload documents to vectorize & store for semantic search:
```bash
npm run ingest -- --client-id <uuid> --dir ./docs
```

Internally: documents → Voyage API embeddings → stored in `pgvector` column.

## Multi-Tenant Architecture & Security

### Row-Level Security (RLS)

All queries must use the `withTenant()` helper:
```typescript
await withTenant(clientId, async (db) => {
  // Any SELECT/INSERT/UPDATE/DELETE here is scoped to clientId
  // RLS policies enforce this at the database level
  const msgs = await db.query("SELECT * FROM messages");
  // Only returns messages for this client, even if query is wrong
});
```

**Critical**: Direct `pool.query()` bypasses RLS. Always use `withTenant()` for business logic.

### Encryption

Sensitive fields (`google_oauth_tokens`, `hubspot_account_id`) are encrypted:
```typescript
import { encrypt, decrypt } from "./utils/encryption";
const decrypted = await decrypt(encryptedValue);
```

Key stored in `ENCRYPTION_KEY` env var.

## Message Pipeline & Tool Use

### Incoming Message Flow

1. **Webhook** (`POST /webhook`): Meta sends message → signature verified
2. **handleIncomingMessage()**: Resolve client → load sector profile → fetch RAG context
3. **converseWithClaude()**: Build system prompt → add history → call Claude with tools
4. **Tool Execution**: Claude requests tool (e.g., `book_appointment`) → executed → response looped back
5. **Send Reply**: Final response sent via `sendWhatsappText()` to contact

### Available Tools

Defined in `src/llm/tools.ts`, executed in `src/llm/executeTool.ts`:

| Tool | Purpose |
|------|---------|
| `check_calendar_availability` | Check free slots in client's Google Calendar |
| `book_appointment` | Create calendar event + record in DB |
| `create_lead` | Qualify & push prospect to HubSpot |
| `send_reminder` | Schedule a follow-up message (queued job) |
| `escalate_to_human` | Mark contact as "escalade" → pause automation |

**Important**: Tools execute in the **tool execution handler**, not inline. They can read/write the database, make HTTP calls, etc.

## Sector Profiles & Templating

Each sector (restaurant, boutique, etc.) has a profile:

```sql
-- Table: sector_profiles
sector_profile_id, nom_secteur, template_system_prompt, 
questions_qualification, champs_rdv, declencheurs_relance_defaut, ...
```

System prompt is a **template** with placeholders:
```
Vous êtes un agent pour {{nom_entreprise}}.
Horaires: {{horaires}}
Spécialités: {{specialites}}
```

Filled at runtime from `clients.variables_prompt`.

## Scheduled Tasks & Worker

### BullMQ Queue

Jobs (reminders, follow-ups) added to Redis queue:

```typescript
// In tool execution or scheduler:
const job = await remindersQueue.add('send-reminder', {
  contactId, message, scheduledFor: futureDate
});
```

### Worker Process

Separate Node process that **must** run continuously:
```bash
npm run worker
```

- Polls Redis for due jobs
- Executes them (send messages, escalate, etc.)
- Retries on failure

**Common issue**: Forgetting to run worker → scheduled messages never send.

## Admin Console Features

- **Dashboard**: Real-time client list + search
- **Wizard**: Multi-step form to create/duplicate clients
- **Sector selector**: Pre-fill from existing profiles
- **Duplicate client**: Clone config + pre-fill form (for rapid scaling)

Uses **Next.js API routes** as middleware to hide `BACKEND_ADMIN_KEY` from browser.

## Testing

Run unit tests with Vitest:
```bash
npm test
```

Key test files:
- `tests/encryption.test.ts`: Crypto utilities
- `tests/resolveClient.test.ts`: Client lookup + prompt building
- `tests/whatsapp.test.ts`: Message parsing

**Tip**: Use `.only` to run single test during development:
```typescript
it.only('should book appointment', async () => { ... });
```

## Common Development Patterns

### Accessing Current Client (Database Queries)

Always use `withTenant()`:
```typescript
const result = await withTenant(client.id, async (db) => {
  return db.query("SELECT * FROM contacts WHERE ...");
});
```

### Building System Prompts

```typescript
import { buildSystemPrompt } from './orchestrator/resolveClient';
const prompt = buildSystemPrompt(client); // Fills sector template with client vars
```

### Retrieving RAG Context

```typescript
const chunks = await retrieveRelevantChunks(clientId, userMessage);
const formattedContext = formatChunksForPrompt(chunks);
// Pass to Claude as context
```

### Calling Claude with Tools

```typescript
const reply = await converseWithClaude({
  systemPrompt,
  history,
  userMessage,
  client,
  contactId,
  ragContext: formattedContext,
});
```

## Debugging Tips

### Check Logs
- **Backend**: `npm run dev` shows real-time logs
- **Worker**: `npm run worker` shows job execution
- **Frontend**: Browser console + Network tab

### Database Inspection

```bash
# Connect to PostgreSQL
psql postgres://whatsapp_agent:whatsapp_agent@localhost:5432/whatsapp_agent

# View tables
\dt
SELECT * FROM clients;
SELECT * FROM contacts WHERE client_id = '...';
SELECT * FROM messages LIMIT 10;
```

### Webhook Testing

Use ngrok or Postman to send mock Meta webhook:
```json
POST http://localhost:3000/webhook
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "33612345678",
          "text": { "body": "Test message" },
          "timestamp": "1691234567"
        }],
        "metadata": { "phone_number_id": "...", "display_phone_number": "..." }
      }
    }]
  }]
}
```

### Rate Limiting

Backend has basic per-IP rate limiting (120 req/min). Adjust in `server.ts` if needed.

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Messages not being processed | Worker not running | `npm run worker` in separate terminal |
| RLS policy errors in logs | Using `pool.query()` instead of `withTenant()` | Refactor to use `withTenant()` |
| Webhooks rejected (401) | Wrong `WHATSAPP_VERIFY_TOKEN` | Regenerate & update Meta dashboard |
| `ENCRYPTION_KEY` invalid format | Not 64-char hex | `node -e "..."` and copy exactly |
| Calendar OAuth fails | `GOOGLE_REDIRECT_URI` mismatch | Ensure URI matches Meta callback config exactly |
| pgvector not found | PostgreSQL extension not installed | Migrations must run; check `docker compose up` |
| `BACKEND_ADMIN_KEY` mismatch | Copied between .env and .env.local incorrectly | Keep in sync; frontend uses via Next.js API routes only |

## Performance & Scaling

- **Database**: Use `EXPLAIN ANALYZE` on slow queries. Indexes on `client_id`, `whatsapp_number` are critical.
- **Vectors**: Limit RAG chunks to top 3–5 most relevant (see `retrieve.ts`).
- **Rate Limiting**: Increase in `server.ts` if needed for high-volume deployments.
- **Redis**: Monitor BullMQ queue depth; scale worker processes if jobs accumulate.

## Deployment (Railway / Docker)

1. Push to GitHub
2. Connect Railway project to repo
3. Set env vars in Railway dashboard
4. **Important**: Run migrations on first deploy:
   - Add release command: `npm run migrate` in Railway settings
5. Scale: 1× backend + 1–N worker processes (separate dynos/services)

## Links & Resources

- [Backend README](./backend/README.md) — Detailed setup & onboarding steps
- [Anthropic SDK Docs](https://github.com/anthropic-ai/sdk-python) — Tool use, Claude models
- [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — Multi-tenancy patterns
- [BullMQ Docs](https://docs.bullmq.io/) — Job queue patterns
- [Meta WhatsApp API](https://developers.facebook.com/docs/whatsapp/cloud-api) — Webhook format, sending messages
- [Next.js API Routes](https://nextjs.org/docs/pages/building-your-application/routing/api-routes) — Admin console backend

---

**Last updated**: 2026-08-23  
**Maintained by**: AI Coding Agents
