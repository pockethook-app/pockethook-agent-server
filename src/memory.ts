/**
 * Long-term memory with SQLite + FTS5.
 *
 * Stores all messages persistently and provides semantic-ish search
 * via full-text search. Used to recall relevant past context without
 * loading the entire conversation history.
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";
import { storeVector, searchSemantic, type VectorSearchResult } from "./vector-memory.js";
import { logger } from "./logger.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(PROJECT_ROOT, "data");
const DB_PATH = join(DATA_DIR, "memory.db");

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");

  // Messages table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      date_str TEXT NOT NULL DEFAULT ''
    )
  `);

  // FTS5 virtual table for full-text search
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content_rowid='id',
      content='messages'
    )
  `);

  // Triggers to keep FTS in sync
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END
  `);

  // Index for session lookups
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)
  `);

  return db;
}

export interface MemoryEntry {
  role: string;
  content: string;
  timestamp: number;
  dateStr: string;
  sessionId: string;
}

/**
 * Store a message in long-term memory.
 */
function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function remember(sessionId: string, role: string, content: string): number {
  const d = getDb();
  const now = Date.now();
  const result = d.run(
    "INSERT INTO messages (session_id, role, content, timestamp, date_str) VALUES (?, ?, ?, ?, ?)",
    [sessionId, role, content, now, formatDate(now)],
  );
  return Number(result.lastInsertRowid);
}

/**
 * Store a message in both FTS5 (sync) and vector memory (async).
 * Vector storage is fire-and-forget — failures don't block the request.
 */
export async function rememberAsync(
  sessionId: string,
  role: string,
  content: string,
  vectorEnabled: boolean,
  wing?: string,
  room?: string,
): Promise<void> {
  const messageId = remember(sessionId, role, content);
  if (vectorEnabled) {
    storeVector(messageId, content, wing ?? "general", room, undefined, role)
      .catch((err) => logger.warn(`Vector store failed for message #${messageId}: ${err instanceof Error ? err.message : err}`));
  }
}

/**
 * Search memory for messages relevant to a query.
 * Returns top-K results ranked by FTS5 relevance.
 *
 * Excludes messages from the current short-term window (last skipRecent messages
 * in the same session) to avoid duplicating what's already in context.
 */
export function recall(query: string, topK: number = 5, sessionId?: string, skipRecent: number = 0): MemoryEntry[] {
  const d = getDb();

  // Clean query for FTS5 — keep only alphanumeric and spaces (Unicode-aware)
  const cleanQuery = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" OR ");

  if (!cleanQuery) return [];

  // Get IDs to exclude (recent messages already in short-term context)
  let excludeIds: number[] = [];
  if (sessionId && skipRecent > 0) {
    const recent = d.query(
      "SELECT id FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?",
    ).all(sessionId, skipRecent) as { id: number }[];
    excludeIds = recent.map((r) => r.id);
  }

  const excludePlaceholders = excludeIds.length > 0
    ? `AND m.id NOT IN (${excludeIds.map(() => "?").join(",")})`
    : "";

  try {
    const params: (string | number)[] = [cleanQuery, ...excludeIds, topK];
    const results = d.query(`
      SELECT m.role, m.content, m.timestamp, m.date_str as dateStr, m.session_id as sessionId
      FROM messages m
      JOIN messages_fts f ON m.id = f.rowid
      WHERE messages_fts MATCH ?
      ${excludePlaceholders}
      ORDER BY f.rank
      LIMIT ?
    `).all(...params) as MemoryEntry[];

    return results;
  } catch {
    // FTS query can fail on unusual input
    return [];
  }
}

/**
 * Get total message count (for stats/debugging).
 */
export function memoryStats(): { totalMessages: number; totalSessions: number } {
  const d = getDb();
  const msg = d.query("SELECT COUNT(*) as count FROM messages").get() as { count: number };
  const sess = d.query("SELECT COUNT(DISTINCT session_id) as count FROM messages").get() as { count: number };
  return { totalMessages: msg.count, totalSessions: sess.count };
}

/**
 * Clean old messages beyond a retention period.
 */
export function cleanOldMemories(retentionMs: number): number {
  const d = getDb();
  const cutoff = Date.now() - retentionMs;
  const result = d.run("DELETE FROM messages WHERE timestamp < ?", [cutoff]);
  return result.changes;
}

/**
 * Get the path to memory.db (for cross-DB operations like migration).
 */
export function getDbPath(): string {
  return DB_PATH;
}

/**
 * Fetch messages by their IDs (for resolving vector search results).
 */
export function getMessagesByIds(ids: number[]): MemoryEntry[] {
  if (ids.length === 0) return [];
  const d = getDb();
  const placeholders = ids.map(() => "?").join(",");
  return d.query(
    `SELECT role, content, timestamp, date_str as dateStr, session_id as sessionId FROM messages WHERE id IN (${placeholders})`,
  ).all(...ids) as MemoryEntry[];
}

/**
 * Hybrid recall: merge FTS5 keyword results with vector semantic results.
 * Uses reciprocal rank fusion to combine both rankings.
 */
export async function recallHybrid(
  query: string,
  topK: number = 5,
  vectorEnabled: boolean = false,
  sessionId?: string,
  skipRecent: number = 0,
  filters?: { wings?: string[]; wing?: string; room?: string },
): Promise<MemoryEntry[]> {
  // Always run FTS5
  const ftsResults = recall(query, topK * 2, sessionId, skipRecent);

  if (!vectorEnabled) return ftsResults.slice(0, topK);

  // Run vector search — first try with filters, fall back to unfiltered if no results
  let vectorResults: VectorSearchResult[];
  try {
    vectorResults = await searchSemantic(query, topK * 2, filters);
    // If filtered search returned nothing, retry without filters
    if (vectorResults.length === 0 && filters && (filters.wings?.length || filters.wing || filters.room)) {
      vectorResults = await searchSemantic(query, topK * 2);
    }
  } catch {
    // Vector search failed — fall back to FTS5 only
    return ftsResults.slice(0, topK);
  }

  if (vectorResults.length === 0) return ftsResults.slice(0, topK);

  // Resolve vector results to full MemoryEntry objects
  const vectorMessageIds = vectorResults.map((r) => r.messageId);
  const vectorMessages = getMessagesByIds(vectorMessageIds);
  const vectorMessageMap = new Map<string, MemoryEntry>();
  for (const m of vectorMessages) {
    vectorMessageMap.set(`${m.sessionId}:${m.timestamp}`, m);
  }

  // Reciprocal rank fusion (k=60)
  const k = 60;
  const scores = new Map<string, { score: number; entry: MemoryEntry }>();

  for (let i = 0; i < ftsResults.length; i++) {
    const entry = ftsResults[i]!;
    const key = `${entry.sessionId}:${entry.timestamp}`;
    const existing = scores.get(key);
    const rrf = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(key, { score: rrf, entry });
    }
  }

  for (let i = 0; i < vectorResults.length; i++) {
    const vr = vectorResults[i]!;
    const msg = vectorMessages.find((m, idx) => vectorMessageIds[idx] === vr.messageId);
    if (!msg) continue;
    const key = `${msg.sessionId}:${msg.timestamp}`;
    const existing = scores.get(key);
    const rrf = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(key, { score: rrf, entry: msg });
    }
  }

  // Sort by combined score, return top-K
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.entry);
}
