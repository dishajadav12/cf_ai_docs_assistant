import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ChatSession } from "./ChatSession";
import { DocsFetchWorkflow } from "./DocsFetchWorkflow";
import type { Env, WorkflowResult } from "./types";

const SESSION_COOKIE = "cf-session-id";
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;

const app = new Hono<{ Bindings: Env }>();

const ALLOWED_ORIGINS = [
	"https://d9ec18d1.docsai.pages.dev",
	"http://127.0.0.1:8788",
	"http://localhost:8788",
	"http://127.0.0.1:8787",
	"http://localhost:8787",
];

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) {
		return false;
	}

	if (ALLOWED_ORIGINS.includes(origin)) {
		return true;
	}

	return origin.endsWith(".pages.dev");
}

app.use("*", async (c, next) => {
	const origin = c.req.header("origin") ?? null;
	const allowed = isAllowedOrigin(origin);

	if (allowed && origin) {
		c.header("Access-Control-Allow-Origin", origin);
		c.header("Access-Control-Allow-Credentials", "true");
	}
	c.header("Vary", "Origin");
	c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type");

	if (c.req.method === "OPTIONS") {
		return c.body(null, 204);
	}

	await next();
});

function normalizeAnswer(output: unknown): string {
	if (!output) {
		return "";
	}

	const candidate = output as Record<string, unknown>;
	if (typeof candidate.answer === "string") {
		return candidate.answer;
	}

	if (candidate.result && typeof candidate.result === "object") {
		const nested = candidate.result as Record<string, unknown>;
		if (typeof nested.answer === "string") {
			return nested.answer;
		}
	}

	if (candidate.output && typeof candidate.output === "object") {
		const nested = candidate.output as Record<string, unknown>;
		if (typeof nested.answer === "string") {
			return nested.answer;
		}
	}

	return "";
}

async function getSessionId(c: Context<{ Bindings: Env }>): Promise<string> {
	const existing = getCookie(c, SESSION_COOKIE);
	if (existing) {
		return existing;
	}

	const sessionId = crypto.randomUUID();
	const requestUrl = new URL(c.req.url);
	setCookie(c, SESSION_COOKIE, sessionId, {
		httpOnly: true,
		sameSite: requestUrl.protocol === "https:" ? "None" : "Lax",
		path: "/",
		maxAge: COOKIE_TTL_SECONDS,
		secure: requestUrl.protocol === "https:",
	});

	return sessionId;
}

function getChatSessionStub(env: Env, sessionId: string): DurableObjectStub {
	const id = env.CHAT_SESSION.idFromName(sessionId);
	return env.CHAT_SESSION.get(id);
}

async function callJson(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<any> {
	const response = await stub.fetch(`https://chat-session${path}`, init);
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		throw new Error(typeof body.error === "string" ? body.error : `Request failed for ${path}`);
	}
	return body;
}

app.get("/", (c) => c.redirect("/index.html", 302));

app.get("/history", async (c) => {
	const sessionId = await getSessionId(c);
	const stub = getChatSessionStub(c.env, sessionId);
	const data = await callJson(stub, "/history", { method: "GET" });
	return c.json({ sessionId, ...data });
});

app.delete("/history", async (c) => {
	const sessionId = await getSessionId(c);
	const stub = getChatSessionStub(c.env, sessionId);

	await callJson(stub, "/history", { method: "DELETE" });

	await c.env.DB.prepare(`DELETE FROM messages WHERE session_id = ?`).bind(sessionId).run();

	return c.json({ ok: true, sessionId });
});

app.post("/context", async (c) => {
	const sessionId = await getSessionId(c);
	const body = (await c.req.json().catch(() => null)) as { context?: string } | null;

	if (typeof body?.context !== "string") {
		return c.json({ error: "context must be a string" }, 400);
	}

	const stub = getChatSessionStub(c.env, sessionId);
	await callJson(stub, "/context", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ context: body.context }),
	});

	await c.env.DB.prepare(
		`INSERT INTO sessions (session_id, context, created_at, updated_at)
		 VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		 ON CONFLICT(session_id) DO UPDATE
		 SET context = excluded.context,
				 updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(sessionId, body.context)
		.run();

	return c.json({ ok: true, sessionId, context: body.context });
});

app.post("/chat", async (c) => {
	const sessionId = await getSessionId(c);
	const origin = c.req.header("origin") ?? null;
	const allowOrigin = isAllowedOrigin(origin) && origin ? origin : null;
	const body = (await c.req.json().catch(() => null)) as { question?: string } | null;
	const question = body?.question?.trim();

	if (!question) {
		return c.json({ error: "question is required" }, 400);
	}

	const instance = await c.env.DOCS_WORKFLOW.create({ params: { question, sessionId } });

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode(sseChunk({ type: "status", value: "workflow-started" })));

			try {
				const maxChecks = 40;
				for (let i = 0; i < maxChecks; i += 1) {
					const status = (await instance.status()) as Record<string, unknown>;
					const state = typeof status.status === "string" ? status.status : "unknown";

					controller.enqueue(
						encoder.encode(
							sseChunk({
								type: "status",
								value: state,
							}),
						),
					);

					if (state === "complete" || state === "completed") {
						const output = (status.output ?? status.result ?? status) as WorkflowResult | unknown;
						const answer = normalizeAnswer(output);

						if (!answer) {
							controller.enqueue(
								encoder.encode(
									sseChunk({
										type: "error",
										message: "workflow completed but returned no answer",
									}),
								),
							);
							break;
						}

						const pieces = answer.split(/(\s+)/).filter((part) => part.length > 0);
						for (const token of pieces) {
							controller.enqueue(encoder.encode(sseChunk({ type: "token", token })));
						}

						controller.enqueue(encoder.encode(sseChunk({ type: "done", answer })));
						break;
					}

					if (state === "errored" || state === "error" || state === "failed" || state === "terminated") {
						const errorText =
							typeof status.error === "string"
								? status.error
								: typeof status.message === "string"
									? status.message
									: "workflow failed";
						controller.enqueue(
							encoder.encode(
								sseChunk({
									type: "error",
									message: errorText,
									status,
								}),
							),
						);
						break;
					}

					  await delay(2000);

					if (i === maxChecks - 1) {
						controller.enqueue(
							encoder.encode(
								sseChunk({
									type: "error",
									message: "workflow timed out while generating response",
								}),
							),
						);
					}
				}
			} catch (error) {
				controller.enqueue(
					encoder.encode(
						sseChunk({
							type: "error",
							message: error instanceof Error ? error.message : "unknown chat error",
						}),
					),
				);
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...(allowOrigin
				? {
						"Access-Control-Allow-Origin": allowOrigin,
						"Access-Control-Allow-Credentials": "true",
						Vary: "Origin",
					}
				: {}),
		},
	});
});

export default app;
export { ChatSession };
export { DocsFetchWorkflow };

