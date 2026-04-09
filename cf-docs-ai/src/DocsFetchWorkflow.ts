import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ChatMessage, Env, WorkflowParams, WorkflowResult } from "./types";

const DOCS_URL = "https://developers.cloudflare.com/llms.txt";
const MODEL_NAME = "@cf/meta/llama-3.1-8b-instruct";

const PRODUCT_KEYWORDS: Record<string, string[]> = {
  workers: ["worker", "workers", "service binding", "cron trigger"],
  durable_objects: ["durable object", "durable objects", "stateful"],
  workflows: ["workflow", "workflows"],
  r2: ["r2", "bucket", "object storage"],
  kv: ["kv", "key-value", "key value"],
  pages: ["pages", "static site", "frontend"],
  d1: ["d1", "sqlite", "database"],
  websocket: ["websocket", "web socket", "socket"],
};

function textFromUnknownChunk(payload: unknown): string {
  if (!payload) {
    return "";
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload === "object") {
    const asRecord = payload as Record<string, unknown>;
    const candidate =
      asRecord.response ??
      asRecord.text ??
      asRecord.output_text ??
      asRecord.delta ??
      asRecord.token;
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return "";
}

async function aggregateAiStream(aiResult: unknown): Promise<string> {
  if (!aiResult) {
    return "";
  }

  if (
    typeof aiResult === "object" &&
    aiResult !== null &&
    "response" in (aiResult as Record<string, unknown>) &&
    typeof (aiResult as Record<string, unknown>).response === "string"
  ) {
    return (aiResult as Record<string, unknown>).response as string;
  }

  if (aiResult instanceof ReadableStream) {
    const reader = aiResult.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffered = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
      const chunks = buffered.split("\n\n");
      buffered = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }

          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(data) as unknown;
            fullText += textFromUnknownChunk(parsed);
          } catch {
            fullText += data;
          }
        }
      }
    }

    return fullText.trim();
  }

  return textFromUnknownChunk(aiResult);
}

function extractIntentFromQuestion(question: string): string[] {
  const lowered = question.toLowerCase();
  const products = new Set<string>();

  for (const [product, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    if (keywords.some((keyword) => lowered.includes(keyword))) {
      products.add(product);
    }
  }

  if (products.size === 0) {
    products.add("workers");
    products.add("pages");
    products.add("d1");
  }

  return Array.from(products);
}

function buildDocsSnippet(llmsText: string, intentProducts: string[]): string {
  const lines = llmsText.split(/\r?\n/);
  const keywords = intentProducts.flatMap((product) => PRODUCT_KEYWORDS[product] ?? [product]);
  const matchedBlocks: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lowered = line.toLowerCase();
    if (!keywords.some((keyword) => lowered.includes(keyword))) {
      continue;
    }

    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 3);
    const block = lines.slice(start, end).join("\n").trim();
    if (!block || seen.has(block)) {
      continue;
    }

    seen.add(block);
    matchedBlocks.push(block);

    if (matchedBlocks.length >= 12) {
      break;
    }
  }

  if (matchedBlocks.length === 0) {
    return lines.slice(0, 40).join("\n");
  }

  return matchedBlocks.join("\n\n---\n\n");
}

async function fetchDocsContext(intentProducts: string[]): Promise<string> {
  const response = await fetch(DOCS_URL, {
    headers: {
      "User-Agent": "cf-docs-ai-assistant/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch Cloudflare docs index: ${response.status}`);
  }

  const llmsText = await response.text();
  return buildDocsSnippet(llmsText, intentProducts);
}

async function readSessionState(env: Env, sessionId: string): Promise<{ history: ChatMessage[]; context: string }> {
  const id = env.CHAT_SESSION.idFromName(sessionId);
  const stub = env.CHAT_SESSION.get(id);
  const response = await stub.fetch("https://chat-session/history");

  if (!response.ok) {
    return { history: [], context: "" };
  }

  const data = (await response.json()) as { history?: ChatMessage[]; context?: string };
  return {
    history: Array.isArray(data.history) ? data.history : [],
    context: typeof data.context === "string" ? data.context : "",
  };
}

async function persistToDurableObject(env: Env, sessionId: string, role: "user" | "assistant", content: string): Promise<void> {
  const id = env.CHAT_SESSION.idFromName(sessionId);
  const stub = env.CHAT_SESSION.get(id);

  await stub.fetch("https://chat-session/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, content }),
  });
}

export class DocsFetchWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<WorkflowResult> {
    const { question, sessionId } = event.payload;
    const retryConfig = {
      limit: 3,
      backoff: "exponential",
    } as const;

    const intentProducts = await step.do(
      "extract-intent",
      { retries: { ...retryConfig, delay: "2 second" } },
      async () => extractIntentFromQuestion(question),
    );

    const docsContext = await step.do(
      "fetch-cf-docs",
      { retries: { ...retryConfig, delay: "2 second" } },
      async () => fetchDocsContext(intentProducts),
    );

    const inferenceOutput = await step.do(
      "run-inference",
      { retries: { ...retryConfig, delay: "2 second" } },
      async () => {
        const { history, context } = await readSessionState(this.env, sessionId);
        const systemPrompt = `You are a Cloudflare expert assistant. Answer questions about Cloudflare's developer platform. Use the user's project context to personalize answers: ${context}`;

        const messages: ChatMessage[] = [
          {
            role: "system",
            content: `${systemPrompt}\nKeep answers concise and practical (max 200 words unless user asks for deep detail).\n\nRelevant Cloudflare docs snippets:\n${docsContext}`,
          },
          ...history,
          {
            role: "user",
            content: question,
          },
        ];

        const stream = await (this.env.AI as any).run(MODEL_NAME, {
          messages,
          stream: true,
          max_tokens: 320,
        });

        const answer = await aggregateAiStream(stream);
        return {
          answer,
          context,
        };
      },
    );

    await step.do(
      "persist-response",
      { retries: { ...retryConfig, delay: "2 second" } },
      async () => {
        await this.env.DB.prepare(
          `INSERT INTO sessions (session_id, context, created_at, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(session_id) DO UPDATE
           SET context = excluded.context,
               updated_at = CURRENT_TIMESTAMP`,
        )
          .bind(sessionId, inferenceOutput.context)
          .run();

        await this.env.DB.prepare(
          `INSERT INTO messages (session_id, role, content, created_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP), (?, ?, ?, CURRENT_TIMESTAMP)`,
        )
          .bind(sessionId, "user", question, sessionId, "assistant", inferenceOutput.answer)
          .run();

        await persistToDurableObject(this.env, sessionId, "user", question);
        await persistToDurableObject(this.env, sessionId, "assistant", inferenceOutput.answer);

        return { ok: true };
      },
    );

    return {
      intent: intentProducts,
      docsContext,
      answer: inferenceOutput.answer,
    };
  }
}
