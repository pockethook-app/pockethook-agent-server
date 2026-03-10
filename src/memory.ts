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

export function remember(sessionId: string, role: string, content: string): void {
  const d = getDb();
  const now = Date.now();
  d.run(
    "INSERT INTO messages (session_id, role, content, timestamp, date_str) VALUES (?, ?, ?, ?, ?)",
    [sessionId, role, content, now, formatDate(now)],
  );
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

  const excludeClause = excludeIds.length > 0
    ? `AND m.id NOT IN (${excludeIds.join(",")})`
    : "";

  try {
    const results = d.query(`
      SELECT m.role, m.content, m.timestamp, m.date_str as dateStr, m.session_id as sessionId
      FROM messages m
      JOIN messages_fts f ON m.id = f.rowid
      WHERE messages_fts MATCH ?
      ${excludeClause}
      ORDER BY f.rank
      LIMIT ?
    `).all(cleanQuery, topK) as MemoryEntry[];

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
