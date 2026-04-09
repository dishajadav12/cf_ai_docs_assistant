export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt?: string;
}

export interface WorkflowParams {
  question: string;
  sessionId: string;
}

export interface WorkflowResult {
  intent: string[];
  docsContext: string;
  answer: string;
}

export interface SessionMetadata {
  createdAt: string;
  messageCount: number;
}

export interface Env {
  AI: Ai;
  CHAT_SESSION: DurableObjectNamespace;
  DOCS_WORKFLOW: Workflow;
  DB: D1Database;
}
