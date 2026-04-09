# PROMPTS.md

This file documents AI-assisted prompts used during development, as required by the assignment.

## Primary Build Prompts

"You are an expert Cloudflare Workers developer. Build me a complete, 
production-ready AI-powered Cloudflare Docs Assistant application 
entirely on Cloudflare's developer platform. 

This is a job application assignment. Every single requirement below 
MUST be fulfilled — do not skip or stub any component.

=== WHAT THE APP DOES ===
A chat interface where developers ask questions about Cloudflare 
(Workers, Durable Objects, Workflows, R2, KV, Pages, D1, etc.).
The AI answers using its knowledge AND remembers the user's project 
context across sessions (e.g., "I'm building a multiplayer game with 
WebSockets") so every answer gets more personalized over time."

=== REQUIRED CLOUDFLARE COMPONENTS ===

"1. LLM — Workers AI
   - Model: @cf/meta/llama-3.1-8b-instruct
   - Use env.AI.run() binding (NOT external API calls)
   - Streaming responses via SSE (stream: true)
   - System prompt: "You are a Cloudflare expert assistant. 
     Answer questions about Cloudflare's developer platform. 
     Use the user's project context to personalize answers: {context}"

2. WORKFLOW — Cloudflare Workflows (durable execution)
   - Class: DocsFetchWorkflow extends WorkflowEntrypoint
   - Steps:
     Step 1: step.do("extract-intent") — parse user question 
             to identify which CF products are relevant
     Step 2: step.do("fetch-cf-docs") — fetch relevant snippets 
             from https://developers.cloudflare.com/llms.txt
     Step 3: step.do("run-inference") — call Workers AI with 
             the docs context + conversation history
     Step 4: step.do("persist-response") — save Q&A pair to D1
   - Each step must have retryConfig: { limit: 3, backoff: "exponential" }
   - Trigger the Workflow from the Worker on each chat message

3. USER INPUT — Chat UI via Cloudflare Pages
   - Single HTML file at ./public/index.html (no frameworks)
   - Clean chat interface with:
     * Text input box + Send button
     * "Set my project context" text area at the top
     * Chat message bubbles (user right, AI left)
     * Streaming response display using EventSource/SSE
   - WebSocket OR fetch to the Worker backend
   - Mobile responsive with simple CSS

4. MEMORY & STATE — Durable Objects + D1
   - Durable Object class: ChatSession
   - One DO instance per user (keyed by sessionId cookie)
   - DO internal SQLite storage holds:
     * conversation history (last 20 messages)
     * user's project context string
     * session metadata (created_at, message_count)
   - Methods on the DO:
     * getHistory() → returns last 20 messages
     * addMessage(role, content) → appends to history
     * setContext(contextString) → saves project context
     * getContext() → returns saved context
   - D1 database for cross-session persistence backup
     Table: sessions(session_id, context, created_at, updated_at)
     Table: messages(id, session_id, role, content, created_at)"

=== FILE STRUCTURE TO CREATE ===
"
cf-docs-ai/
├── wrangler.toml          ← all bindings declared
├── src/
│   ├── index.ts           ← main Worker (routing, auth, SSE)
│   ├── ChatSession.ts     ← Durable Object class
│   ├── DocsFetchWorkflow.ts ← Workflow class
│   └── types.ts           ← shared TypeScript interfaces
├── public/
│   └── index.html         ← full chat UI (Pages)
├── schema.sql             ← D1 table definitions
└── package.json

=== wrangler.toml MUST INCLUDE ===

name = "cf-docs-ai"
main = "src/index.ts"
compatibility_date = "2024-09-23"

[ai]
binding = "AI"

[[durable_objects.bindings]]
name = "CHAT_SESSION"
class_name = "ChatSession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatSession"]

[[workflows]]
name = "docs-fetch-workflow"
binding = "DOCS_WORKFLOW"
class_name = "DocsFetchWorkflow"

[[d1_databases]]
binding = "DB"
database_name = "cf-docs-ai-db"
database_id = "placeholder-replace-after-wrangler-d1-create""

=== WORKER ROUTES (src/index.ts) ===

POST /chat         → triggers Workflow, returns SSE stream
GET  /history      → returns chat history from DO
POST /context      → saves project context to DO
GET  /             → serves index.html from Pages (or redirect)

Use Hono framework for routing.
Set session cookie (cf-session-id) using crypto.randomUUID() if not present.
Route each request to the correct ChatSession DO by session ID.

=== KEY IMPLEMENTATION DETAILS ===

- In src/index.ts: fetch the ChatSession DO stub using:
  const id = env.CHAT_SESSION.idFromName(sessionId);
  const stub = env.CHAT_SESSION.get(id);

- In DocsFetchWorkflow: trigger from Worker using:
  const instance = await env.DOCS_WORKFLOW.create({ params: { question, sessionId } });
  
- For SSE streaming: return a Response with:
  headers: { "Content-Type": "text/event-stream", 
             "Cache-Control": "no-cache" }

- Workers AI streaming call:
  const stream = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [...history, { role: "user", content: question }],
    stream: true,
    max_tokens: 1024,
  });

- ChatSession DO must use SQLite storage (this.ctx.storage.sql):
  this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages ...`);

=== ENVIRONMENT TYPES (src/types.ts) ===

interface Env {
  AI: Ai;
  CHAT_SESSION: DurableObjectNamespace;
  DOCS_WORKFLOW: Workflow;
  DB: D1Database;
}

=== EXPORTS (src/index.ts) ===
export default app;          // Hono Worker
export { ChatSession };      // Durable Object
export { DocsFetchWorkflow }; // Workflow


Write complete, working TypeScript code for every file. 
Do not use placeholder comments like "// add logic here". 
Every function must be fully implemented."

Key requirements in that prompt included:

- Workers AI model integration
- Workflow orchestration with specific step names
- Durable Object per-session memory
- D1 persistence schema
- Hono routes and SSE streaming
- Pages chat UI
- Full deployment and local run instructions

## Follow-up Improvement Prompts

- "Provision a D1 database for this project using Wrangler, retrieve the generated database_id, update wrangler.toml, and execute schema.sql against both local and remote targets. Report exact commands executed and outcomes."
- "Execute the production deployment pipeline in order: deploy Worker (API + Workflow + Durable Object bindings) and then deploy Pages static assets. Return deployment URLs and verification status."
- "Provide reproducible local run instructions with command-level detail for both backend (wrangler dev) and frontend (wrangler pages dev), including how to validate session persistence and D1 writes."
- "Investigate duplicate history fetches and resolve the root cause in frontend initialization logic. Implement a non-blocking assistant 'thinking' indicator (three-dot animation) that is replaced by streamed tokens on first response chunk."
- "Implement end-to-end chat history reset functionality: add backend route(s) to clear session history safely, wire UI controls, and ensure state consistency between Durable Object memory and D1 persistence."
- "Refactor the UI layout to a split-pane architecture: project context panel at 30% width and chat panel at 70% width on desktop, with responsive stacking on mobile while preserving accessibility and existing interactions."
- "Set the project context textarea to a minimum height of 700px without regressing responsive behavior or overlapping adjacent chat components."

## Bug Fix / Debug Prompts

- "Network error while contacting the assistant."
- "workflow: errored"

## AI Assistance Scope

AI assistance was used for:

- Architecture scaffolding
- TypeScript/Workers implementation updates
- UI/UX iteration
- Debugging and deployment workflows
- Documentation generation

All outputs were reviewed, edited, tested, and integrated in this repository context.
