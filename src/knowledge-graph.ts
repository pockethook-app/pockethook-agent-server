/**
 * Temporal knowledge graph — triple store with validity periods.
 *
 * Stores (subject, predicate, object) facts with valid_from/valid_until timestamps.
 * When a new fact contradicts an existing one (same subject+predicate, different object),
 * the old fact is automatically invalidated.
 *
 * Uses the same knowledge.db as vector-memory.ts.
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(PROJECT_ROOT, "data");
const KB_PATH = join(DATA_DIR, "knowledge.db");

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(KB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");

  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_triples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      source_session TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_triples_subject ON knowledge_triples(subject)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_triples_subj_pred ON knowledge_triples(subject, predicate)`);

  return db;
}

export interface Triple {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  validUntil: number | null;
  sourceSession: string | null;
  createdAt: number;
}

// Predicates that naturally have multiple values (one-to-many relationships)
const MULTI_VALUE_PREDICATES = new Set([
  "child", "children", "son", "daughter",
  "sibling", "brother", "sister",
  "friend", "colleague", "coworker", "teammate",
  "pet", "hobby", "skill", "language",
  "allergy", "medication",
  "project", "tool",
  "visited", "went_to",
  "hijo", "hija", "hermano", "hermana",
  "amigo", "compañero", "mascota", "afición",
]);

interface AddTripleOptions {
  validFrom?: number;
  sourceSession?: string;
  /** Force multi-value mode (don't invalidate existing triples with same subject+predicate) */
  multiValue?: boolean;
}

/**
 * Add a fact. For single-value predicates (lives_in, partner, etc.),
 * auto-invalidates any existing active triple with the same subject+predicate.
 * For multi-value predicates (child, friend, colleague, etc.), allows
 * multiple active values simultaneously.
 */
export function addTriple(
  subject: string,
  predicate: string,
  object: string,
  opts?: AddTripleOptions,
): number {
  const d = getDb();
  const now = Date.now();
  const validFrom = opts?.validFrom ?? now;

  const isMultiValue = opts?.multiValue || MULTI_VALUE_PREDICATES.has(predicate.toLowerCase());

  // Check for existing active triple with same subject+predicate+object (exact duplicate)
  const exactDupe = d.query(
    "SELECT id FROM knowledge_triples WHERE subject = ? AND predicate = ? AND object = ? AND valid_until IS NULL",
  ).get(subject, predicate, object) as { id: number } | null;

  if (exactDupe) {
    // Same exact fact already stored — return existing ID
    return exactDupe.id;
  }

  // For single-value predicates, invalidate the old value
  if (!isMultiValue) {
    const existing = d.query(
      "SELECT id, object FROM knowledge_triples WHERE subject = ? AND predicate = ? AND valid_until IS NULL",
    ).get(subject, predicate) as { id: number; object: string } | null;

    if (existing) {
      d.run("UPDATE knowledge_triples SET valid_until = ? WHERE id = ?", [now, existing.id]);
    }
  }

  const result = d.run(
    "INSERT INTO knowledge_triples (subject, predicate, object, valid_from, valid_until, source_session, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    [subject, predicate, object, validFrom, opts?.sourceSession ?? null, now],
  );

  return Number(result.lastInsertRowid);
}

/**
 * Query triples by subject, optionally filtering by predicate.
 * By default returns only currently valid facts (valid_until IS NULL).
 */
export function queryTriples(
  subject: string,
  predicate?: string,
  activeOnly: boolean = true,
): Triple[] {
  const d = getDb();
  let sql = "SELECT * FROM knowledge_triples WHERE subject = ?";
  const params: (string | number)[] = [subject];

  if (predicate) {
    sql += " AND predicate = ?";
    params.push(predicate);
  }

  if (activeOnly) {
    sql += " AND valid_until IS NULL";
  }

  sql += " ORDER BY valid_from DESC";

  return (d.query(sql).all(...params) as any[]).map(mapTriple);
}

/**
 * Invalidate a specific triple (set valid_until to now).
 */
export function invalidateTriple(id: number): boolean {
  const d = getDb();
  const result = d.run(
    "UPDATE knowledge_triples SET valid_until = ? WHERE id = ? AND valid_until IS NULL",
    [Date.now(), id],
  );
  return result.changes > 0;
}

/**
 * Search triples by keyword across subject, predicate, and object.
 * Returns currently valid triples matching the query.
 */
export function searchTriples(query: string, activeOnly: boolean = true): Triple[] {
  const d = getDb();
  const pattern = `%${query}%`;
  let sql = "SELECT * FROM knowledge_triples WHERE (subject LIKE ? OR predicate LIKE ? OR object LIKE ?)";
  const params: string[] = [pattern, pattern, pattern];

  if (activeOnly) {
    sql += " AND valid_until IS NULL";
  }

  sql += " ORDER BY valid_from DESC LIMIT 20";

  return (d.query(sql).all(...params) as any[]).map(mapTriple);
}

/**
 * Get stats about the knowledge graph.
 */
export function tripleStats(): { totalTriples: number; activeTriples: number; subjects: number } {
  const d = getDb();
  const total = (d.query("SELECT COUNT(*) as count FROM knowledge_triples").get() as { count: number }).count;
  const active = (d.query("SELECT COUNT(*) as count FROM knowledge_triples WHERE valid_until IS NULL").get() as { count: number }).count;
  const subjects = (d.query("SELECT COUNT(DISTINCT subject) as count FROM knowledge_triples").get() as { count: number }).count;
  return { totalTriples: total, activeTriples: active, subjects };
}

function mapTriple(row: any): Triple {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    sourceSession: row.source_session,
    createdAt: row.created_at,
  };
}
