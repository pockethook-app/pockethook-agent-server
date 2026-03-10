import type { UserMessage, AssistantMessage, Message } from "@mariozechner/pi-ai";
import { remember, recall, type MemoryEntry } from "./memory.js";

/**
 * Session management: short-term (in-memory) + long-term (SQLite FTS5).
 *
 * Short-term: last N messages, used directly in LLM context.
 * Long-term: all messages in SQLite, searched via FTS5 for relevant recall.
 */

interface Session {
  messages: Message[];
  lastAccess: number;
}

const sessions = new Map<string, Session>();

/**
 * Get recent messages (short-term window) for a session.
 */
export function getMessages(sessionId: string): Message[] {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastAccess = Date.now();
    return session.messages;
  }
  return [];
}

/**
 * Build the full context for the LLM:
 * recalled memories (relevant past) + recent messages (short-term window).
 */
export function buildContext(sessionId: string, userQuery: string, maxRecall: number = 5): Message[] {
  const recentMessages = getMessages(sessionId);

  // Build enriched query: user query + key words from recent messages
  // This ensures follow-ups like "cuándo?" find relevant past messages
  let searchQuery = userQuery;
  if (recentMessages.length > 0) {
    const words = new Set<string>();
    for (const m of recentMessages.slice(-4)) {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
          : "";
      for (const w of text.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
        if (w.length > 3) words.add(w.toLowerCase());
      }
    }
    if (words.size > 0) {
      // Limit to 10 keywords to keep FTS5 fast
      searchQuery = `${userQuery} ${[...words].slice(0, 10).join(" ")}`;
    }
  }

  // Search long-term memory with enriched query, excluding messages already in short-term window
  const memories = recall(searchQuery, maxRecall, sessionId, recentMessages.length);

  if (memories.length === 0) {
    return recentMessages;
  }

  // Format recalled memories as a system-injected user message at the start
  const memoryContext = formatMemories(memories);
  const memoryMessage: UserMessage = {
    role: "user",
    content: `[Recalled from past conversations — the dates shown indicate when each message was said. Use as context if relevant.]\n\n${memoryContext}`,
    timestamp: memories[0]!.timestamp,
  };

  // Fake assistant ack to keep message alternation valid
  const ackMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Understood, I'll use that context if relevant." }],
    api: "anthropic-messages" as any,
    provider: "",
    model: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: memories[0]!.timestamp,
  };

  return [memoryMessage, ackMessage, ...recentMessages];
}

function formatMemories(memories: MemoryEntry[]): string {
  return memories
    .map((m) => `[Said on ${m.dateStr || "unknown date"}] ${m.role}: ${m.content}`)
    .join("\n\n");
}

/**
 * Add a user message — saves to both short-term and long-term memory.
 */
export function addUserMessage(sessionId: string, content: string): void {
  const session = getOrCreate(sessionId);
  const msg: UserMessage = {
    role: "user",
    content,
    timestamp: Date.now(),
  };
  session.messages.push(msg);
  remember(sessionId, "user", content);
}

/**
 * Add an assistant message — saves to both short-term and long-term memory.
 */
export function addAssistantMessage(sessionId: string, message: AssistantMessage): void {
  const session = getOrCreate(sessionId);
  session.messages.push(message);

  // Extract text for long-term storage
  const text = message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");
  if (text) {
    remember(sessionId, "assistant", text);
  }
}

/**
 * Trim short-term window to maxMessages.
 */
export function trimHistory(sessionId: string, maxMessages: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(-maxMessages);
  }
}

/**
 * Clean expired short-term sessions (long-term memory persists in SQLite).
 */
export function cleanExpiredSessions(ttlMs: number): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > ttlMs) {
      sessions.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}

function getOrCreate(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { messages: [], lastAccess: Date.now() };
    sessions.set(sessionId, session);
  }
  session.lastAccess = Date.now();
  return session;
}
