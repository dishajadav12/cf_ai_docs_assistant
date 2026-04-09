# cf_ai_docs_assistant

AI-powered Cloudflare Docs Assistant built for the Cloudflare optional assignment.

This app lets developers ask questions about Cloudflare products (Workers, Durable Objects, Workflows, D1, R2, KV, Pages, and more). It personalizes answers over time using project context and per-session memory.

## Assignment Coverage

This project includes all required AI app components:

- LLM: Workers AI using `@cf/meta/llama-3.1-8b-instruct` via `env.AI.run()`
- Workflow / coordination: Cloudflare Workflows + Durable Objects
- User input: Chat UI on Pages (`public/index.html`)
- Memory / state:
  - Durable Object SQLite state per session (`ChatSession`)
  - D1 persistence for session + message backup

## Architecture

### Frontend (Pages)

- File: `cf-docs-ai/public/index.html`
- Vanilla HTML/CSS/JS chat interface
- Features:
  - Set project context
  - Chat input + streaming output
  - Thinking dots animation
  - Clear history button
  - Responsive split layout (context and chat side by side)

### Backend (Workers)

- File: `cf-docs-ai/src/index.ts`
- Hono routes:
  - `GET /history`
  - `DELETE /history`
  - `POST /context`
  - `POST /chat` (SSE streaming)
- Session routing uses cookie `cf-session-id` and Durable Object instance per session

### Durable Object Memory

- File: `cf-docs-ai/src/ChatSession.ts`
- SQLite in DO storage for:
  - Last 20 messages
  - Project context
  - Session metadata (`created_at`, `message_count`)

### Workflow Pipeline

- File: `cf-docs-ai/src/DocsFetchWorkflow.ts`
- `DocsFetchWorkflow` steps:
  1. `extract-intent`
  2. `fetch-cf-docs` from `https://developers.cloudflare.com/llms.txt`
  3. `run-inference` using Workers AI
  4. `persist-response` to D1 and Durable Object
- Retry policy: exponential backoff with retry limit

### Database

- Schema file: `cf-docs-ai/schema.sql`
- D1 tables:
  - `sessions`
  - `messages`

## Repository Structure

```
.
├── README.md                 # This file (root submission docs)
├── PROMPTS.md                # AI prompts used
├── wrangler.jsonc            # Parent workspace config
├── public/                   # Parent-level static folder (legacy)
└── cf-docs-ai/               # Main assignment app
    ├── wrangler.toml
    ├── package.json
    ├── schema.sql
    ├── src/
    └── public/
```

## Prerequisites

- Node.js 18+
- npm
- Wrangler CLI (`npm i -g wrangler` optional; local package also works)
- Cloudflare account with:
  - Workers
  - D1
  - Workflows
  - Workers AI enabled

## Setup

### 1) Install dependencies

```bash
cd "cf-docs-ai"
npm install
```

### 2) Create D1 database (first time only)

```bash
wrangler d1 create cf-docs-ai-db
```

Copy the returned `database_id` into `cf-docs-ai/wrangler.toml`.

### 3) Apply schema

```bash
wrangler d1 execute cf-docs-ai-db --file=./schema.sql --local --config=./wrangler.toml
wrangler d1 execute cf-docs-ai-db --file=./schema.sql --remote --config=./wrangler.toml
```

## Run Locally

Use two terminals.

Terminal A (Worker API):

```bash
cd "cf-docs-ai"
wrangler dev --config=./wrangler.toml
```

Terminal B (Pages UI):

```bash
cd "cf-docs-ai"
wrangler pages dev ./public --compatibility-date=2024-09-23
```

Open the Pages local URL shown in terminal.

If needed, force API target with query string:

```
?api=http://127.0.0.1:8788
```

## Deploy

From `cf-docs-ai`:

```bash
wrangler deploy --config=./wrangler.toml
wrangler pages deploy ./public --project-name=docsai
```

## Deployed Endpoints

- Worker API: `https://cf-docs-ai.dishaoncloud.workers.dev`
- Latest Pages deployment URL is printed by Wrangler after deploy.

## Test Checklist

1. Set project context and save.
2. Ask a Cloudflare question.
3. Confirm streaming answer appears.
4. Refresh and verify session history/context persists.
5. Clear history and verify it is removed.
6. Check D1 rows:

```bash
wrangler d1 execute cf-docs-ai-db --command="SELECT * FROM sessions;" --local --config=./wrangler.toml
wrangler d1 execute cf-docs-ai-db --command="SELECT * FROM messages ORDER BY id DESC LIMIT 10;" --local --config=./wrangler.toml
```

