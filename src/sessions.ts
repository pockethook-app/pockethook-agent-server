import type { UserMessage, AssistantMessage, Message } from "@mariozechner/pi-ai";
import { remember, recall, rememberAsync, recallHybrid, type MemoryEntry } from "./memory.js";
import { queryTriples, searchTriples, type Triple } from "./knowledge-graph.js";
import { extractQueryEntities } from "./vector-memory.js";
import { logger } from "./logger.js";

export const FAKE_ACK_TEXT = "Understood, I'll use that context if relevant.";

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
 * recalled memories (relevant past) + knowledge graph facts + recent messages (short-term window).
 */
export async function buildContext(
  sessionId: string,
  userQuery: string,
  vectorEnabled: boolean = false,
  maxRecall: number = 5,
): Promise<Message[]> {
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

  // Extract entities from query for focused search
  let queryEntities: { wings: string[]; room: string | null } = { wings: [], room: null };
  if (vectorEnabled) {
    try {
      queryEntities = await extractQueryEntities(userQuery);
    } catch {
      // Extraction failed — search without filters
    }
  }

  // Search long-term memory (hybrid FTS5 + vector if enabled)
  const filters = queryEntities.wings.length > 0 || queryEntities.room
    ? { wings: queryEntities.wings.length > 0 ? queryEntities.wings : undefined, room: queryEntities.room ?? undefined }
    : undefined;
  const memories = await recallHybrid(searchQuery, maxRecall, vectorEnabled, sessionId, recentMessages.length, filters);

  // Search knowledge graph for relevant facts
  let facts: Triple[] = [];
  if (vectorEnabled) {
    try {
      // Use extracted wings to query knowledge graph precisely
      const subjects = queryEntities.wings.length > 0
        ? queryEntities.wings
        : ["user"]; // Default: always include user facts

      for (const subject of subjects) {
        const subjectFacts = queryTriples(subject);
        for (const t of subjectFacts) {
          if (!facts.some((f) => f.id === t.id)) {
            facts.push(t);
          }
        }
      }

      // Also search by keywords for entities not captured as wings
      const queryWords = userQuery
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
      for (const word of queryWords.slice(0, 5)) {
        const found = searchTriples(word, true);
        for (const t of found) {
          if (!facts.some((f) => f.id === t.id)) {
            facts.push(t);
          }
        }
      }

      // Always include user facts
      if (!subjects.includes("user")) {
        const userFacts = queryTriples("user");
        for (const t of userFacts) {
          if (!facts.some((f) => f.id === t.id)) {
            facts.push(t);
          }
        }
      }
    } catch (err) {
      logger.warn(`Knowledge graph query failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (memories.length === 0 && facts.length === 0) {
    return recentMessages;
  }

  // Build context injection
  let contextParts: string[] = [];

  if (memories.length > 0) {
    contextParts.push(
      "[Recalled from past conversations — the dates shown indicate when each message was said. Use as context if relevant.]\n\n"
      + formatMemories(memories),
    );
  }

  if (facts.length > 0) {
    contextParts.push(
      "[Known facts from knowledge graph — currently valid.]\n\n"
      + formatFacts(facts),
    );
  }

  const memoryMessage: UserMessage = {
    role: "user",
    content: contextParts.join("\n\n---\n\n"),
    timestamp: memories[0]?.timestamp ?? Date.now(),
  };

  // Fake assistant ack to keep message alternation valid
  const ackMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: FAKE_ACK_TEXT }],
    api: "anthropic-messages" as any,
    provider: "",
    model: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: memories[0]?.timestamp ?? Date.now(),
  };

  return [memoryMessage, ackMessage, ...recentMessages];
}

function formatMemories(memories: MemoryEntry[]): string {
  return memories
    .map((m) => `[Said on ${m.dateStr || "unknown date"}] ${m.role}: ${m.content}`)
    .join("\n\n");
}

function formatFacts(facts: Triple[]): string {
  return facts
    .map((t) => `${t.subject} → ${t.predicate} → ${t.object}`)
    .join("\n");
}

/**
 * Add a user message — saves to both short-term and long-term memory.
 * When vectorEnabled, also stores embedding asynchronously (fire-and-forget).
 */
export function addUserMessage(sessionId: string, content: string, vectorEnabled: boolean = false): void {
  const session = getOrCreate(sessionId);
  const msg: UserMessage = {
    role: "user",
    content,
    timestamp: Date.now(),
  };
  session.messages.push(msg);
  if (vectorEnabled) {
    rememberAsync(sessionId, "user", content, true)
      .catch((err) => logger.warn(`rememberAsync failed: ${err instanceof Error ? err.message : err}`));
  } else {
    remember(sessionId, "user", content);
  }
}

/**
 * Add an assistant message — saves to both short-term and long-term memory.
 */
export function addAssistantMessage(sessionId: string, message: AssistantMessage, vectorEnabled: boolean = false): void {
  const session = getOrCreate(sessionId);
  session.messages.push(message);

  // Extract text for long-term storage
  const text = message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");
  if (text) {
    if (vectorEnabled) {
      rememberAsync(sessionId, "assistant", text, true)
        .catch((err) => logger.warn(`rememberAsync failed: ${err instanceof Error ? err.message : err}`));
    } else {
      remember(sessionId, "assistant", text);
    }
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
