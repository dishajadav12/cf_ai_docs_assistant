import type { ChatMessage, ChatRole, Env, SessionMetadata } from "./types";

const MAX_HISTORY = 20;

export class ChatSession {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', ?)` ,
      new Date().toISOString(),
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO metadata (key, value) VALUES ('message_count', '0')`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO metadata (key, value) VALUES ('context', '')`,
    );
  }

  private readMetadata(key: string): string | null {
    const rows = Array.from(
      this.ctx.storage.sql.exec(`SELECT value FROM metadata WHERE key = ?`, key),
    ) as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  }

  async getHistory(): Promise<ChatMessage[]> {
    const rows = Array.from(
      this.ctx.storage.sql.exec(
        `SELECT role, content, created_at
         FROM messages
         ORDER BY id DESC
         LIMIT ?`,
        MAX_HISTORY,
      ),
    ) as Array<{ role: ChatRole; content: string; created_at: string }>;

    return rows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async addMessage(role: ChatRole, content: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)` ,
      role,
      content,
      new Date().toISOString(),
    );

    this.ctx.storage.sql.exec(
      `UPDATE metadata
       SET value = CAST(COALESCE(value, '0') AS INTEGER) + 1
       WHERE key = 'message_count'`,
    );

    this.ctx.storage.sql.exec(`
      DELETE FROM messages
      WHERE id NOT IN (
        SELECT id
        FROM messages
        ORDER BY id DESC
        LIMIT ${MAX_HISTORY}
      )
    `);
  }

  async setContext(contextString: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO metadata (key, value)
       VALUES ('context', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      contextString,
    );
  }

  async getContext(): Promise<string> {
    return this.readMetadata("context") ?? "";
  }

  async clearHistory(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
    this.ctx.storage.sql.exec(
      `INSERT INTO metadata (key, value)
       VALUES ('message_count', '0')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  async getMetadata(): Promise<SessionMetadata> {
    const createdAt = this.readMetadata("created_at") ?? new Date().toISOString();
    const messageCount = Number.parseInt(this.readMetadata("message_count") ?? "0", 10);

    return {
      createdAt,
      messageCount: Number.isNaN(messageCount) ? 0 : messageCount,
    };
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/history" && request.method === "GET") {
      const [history, context, metadata] = await Promise.all([
        this.getHistory(),
        this.getContext(),
        this.getMetadata(),
      ]);
      return this.json({ history, context, metadata });
    }

    if (url.pathname === "/history" && request.method === "DELETE") {
      await this.clearHistory();
      const metadata = await this.getMetadata();
      return this.json({ ok: true, metadata });
    }

    if (url.pathname === "/message" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as
        | { role?: ChatRole; content?: string }
        | null;
      if (!body?.role || !body?.content) {
        return this.json({ error: "role and content are required" }, 400);
      }

      if (!["system", "user", "assistant"].includes(body.role)) {
        return this.json({ error: "invalid role" }, 400);
      }

      await this.addMessage(body.role, body.content);
      return this.json({ ok: true });
    }

    if (url.pathname === "/context" && request.method === "GET") {
      const context = await this.getContext();
      return this.json({ context });
    }

    if (url.pathname === "/context" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as
        | { context?: string }
        | null;

      if (typeof body?.context !== "string") {
        return this.json({ error: "context must be a string" }, 400);
      }

      await this.setContext(body.context);
      return this.json({ ok: true, context: body.context });
    }

    return this.json({ error: "not found" }, 404);
  }
}
