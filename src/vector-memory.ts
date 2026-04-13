/**
 * Palace-style vector memory store.
 *
 * Stores embedding vectors in a separate knowledge.db with
 * wing/room/hall metadata for categorized semantic search.
 * References message IDs from the main memory.db.
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";
import { getEmbedding, cosineSimilarity, vectorToBlob, blobToVector } from "./embeddings.js";
import { quickPrompt } from "./llm.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

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
    CREATE TABLE IF NOT EXISTS memory_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      wing TEXT NOT NULL DEFAULT 'general',
      room TEXT NOT NULL DEFAULT 'context',
      hall TEXT,
      status TEXT NOT NULL DEFAULT 'area',
      embedding BLOB NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Migration: add status column if upgrading from older schema
  try { db.run("ALTER TABLE memory_vectors ADD COLUMN status TEXT NOT NULL DEFAULT 'area'"); } catch {}

  db.run(`CREATE INDEX IF NOT EXISTS idx_vectors_wing ON memory_vectors(wing)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vectors_wing_room ON memory_vectors(wing, room)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vectors_message ON memory_vectors(message_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_vectors_status ON memory_vectors(status)`);

  return db;
}

export interface VectorSearchResult {
  messageId: number;
  wing: string;
  room: string;
  hall: string | null;
  status: string;
  score: number;
}

// ── Valid room and hall values ───────────────────────────────────────────

// Wing is free-form — the LLM picks the entity. Common patterns:
// "user", "assistant", "project:<name>", "person:<name>", "place:<name>",
// "pet:<name>", "company:<name>", "general"

const VALID_ROOMS = [
  "facts", "preferences", "opinions", "decisions", "events",
  "requests", "instructions", "answers", "suggestions", "context",
] as const;

const VALID_HALLS = [
  "personal", "people", "places", "travel", "work", "tech", "health",
  "finance", "entertainment", "food", "shopping", "education", "sports",
  "home", "pets", "weather", "transport", "legal", "communication",
  "calendar", "creative", "news",
] as const;

const VALID_STATUSES = [
  "project",  // active, with outcome/deadline (PARA "Projects")
  "area",     // ongoing responsibility, no deadline (PARA "Areas") — DEFAULT
  "resource", // reference material, topics of interest (PARA "Resources")
  "archive",  // inactive, kept for history (PARA "Archive")
] as const;

const CLASSIFY_PROMPT = `Classify this message into wing, room, hall and status categories. Respond ONLY with a JSON object, no other text.

Wing (the main entity this message is about — free-form, use "entity_type:name" format):
- "user" — about the user themselves (personal info, preferences, actions, plans)
- "assistant" — about the assistant's own responses
- "person:<name>" — about a specific person (e.g. "person:john", "person:maria")
- "project:<name>" — about a specific project (e.g. "project:blog", "project:app")
- "company:<name>" — about a company/organization (e.g. "company:google")
- "place:<name>" — about a specific place (e.g. "place:madrid", "place:office")
- "pet:<name>" — about a pet (e.g. "pet:rex")
- "product:<name>" — about a product/service (e.g. "product:iphone")
- "general" — general conversation, greetings, small talk
Use lowercase names. Pick the most specific entity.

Room (type of memory): ${VALID_ROOMS.join(", ")}
Hall (topic): ${VALID_HALLS.join(", ")}
Status (PARA — how actionable is this memory):
- "project" — active undertaking with a specific outcome or deadline (e.g. "publish PocketHook v1", "plan Japan trip 2026-06"). Use when there is a concrete goal AND a rough time horizon.
- "resource" — reference material, interests, lists, recommendations, tutorials, definitions, explanations, or any generated content that is useful for future consultation (e.g. "cat breeds list", "book recommendations", "recipe ideas", "how to set up X", "pros/cons of Y"). Use this for ANY enumerated list, Q&A answer, tutorial, or informational content the user may want to look up later.
- "area" — ongoing life responsibility or personal context without a specific goal or reference value (e.g. "user's health", "user's family", "work routines", "daily mood"). Use for personal state, facts about the user, and conversational context.
- "archive" — completed, cancelled, or no longer relevant

Rules:
- wing, room, status are required
- hall is optional, use null if no topic fits clearly
- IMPORTANT about wing:
  - When the user (role: user) talks about THEMSELVES — including their plans, cancellations, activities, feelings, or anything they do or decide — wing MUST be "user". This applies even when the sentence mentions a place or person (e.g., "Voy a Barcelona" → wing="user", NOT "place:barcelona"; "No voy a Barcelona" → wing="user", NOT "place:barcelona").
  - When the assistant (role: assistant) responds TO the user (greeting them, answering their question, acknowledging them, confirming their plans), wing MUST be "assistant", never "person:<user's name>"
  - Use "person:<name>", "place:<name>", "project:<name>", etc. ONLY when the message is PRIMARILY ABOUT that entity as a third party (e.g., "Barcelona tiene buen clima" → place:barcelona; "My brother Juan works at Google" → person:juan).
  - Rule of thumb: if the grammatical subject of the sentence is "I/yo/me" (explicit or implicit), wing is "user".
- For wing, use "project:<name>" only when discussing a specific named project
- IMPORTANT about status — decide in this order:
  1. If the user explicitly cancels, completes, or says something is over → "archive"
  2. If the content is a LIST, RECOMMENDATION, TUTORIAL, DEFINITION, EXPLANATION, Q&A answer, or any enumerated/reference material (even short ones like "3 books similar to X") → "resource". This applies to BOTH the user's request ("give me 3 books...") AND the assistant's answer (the actual list).
  3. If the message is part of a concrete project with a deadline or named outcome → "project"
  4. Otherwise, if it's personal info, conversational context, or ongoing life state → "area"
- EXAMPLES:
  - "Give me 3 books like Ender's Game" → resource (reference request)
  - "Here are 3 books: ..." (assistant reply with list) → resource
  - "I'm planning a trip to Japan in June" → project
  - "Perfect, I'll note your Japan trip in June" (assistant confirming a project plan) → project (assistant reply inherits the project status when confirming a plan)
  - "I want a list of documentaries about Japan for my trip" → resource (list request, even inside a project)
  - "I feel tired today" → area (personal state)
  - "My mother is called Sarah" → area (personal fact)
  - "Cancel the Japan trip" → archive (explicit cancellation)
  - "I'm going to Barcelona next week" → project (has date + outcome)
  - "Perfect, noting your Barcelona trip for next week" (assistant) → project (inherits from the plan)
- RULE: when the assistant confirms, acknowledges, or replies about a project/plan the user just stated, the assistant's reply inherits the same status ("project") — it does NOT drop to "area".
- Be precise, not everything is "context" or "general"

Message (role: {role}):
{content}

JSON:`;

let llmConfig: Config | null = null;

export function configureClassifier(config: Config): void {
  llmConfig = config;
}

/**
 * Classify content using the LLM. Falls back to defaults on failure.
 */
export async function classifyContent(content: string, role: string): Promise<{ wing: string; room: string; hall: string | null; status: string }> {
  const defaultWing = role === "user" ? "user" : "assistant";
  if (!llmConfig) {
    return { wing: defaultWing, room: "context", hall: null, status: "area" };
  }

  try {
    const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
    const prompt = CLASSIFY_PROMPT
      .replace("{role}", role)
      .replace("{content}", truncated);

    const text = await quickPrompt(llmConfig, prompt, 100);

    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return { wing: defaultWing, room: "context", hall: null, status: "area" };

    const parsed = JSON.parse(jsonMatch[0]) as { wing?: string; room?: string; hall?: string | null; status?: string };

    let wing = defaultWing;
    if (parsed.wing && typeof parsed.wing === "string" && parsed.wing.length <= 100) {
      wing = parsed.wing.toLowerCase().trim();
    }

    const room = VALID_ROOMS.includes(parsed.room as any) ? parsed.room! : "context";
    const hall = parsed.hall && VALID_HALLS.includes(parsed.hall as any) ? parsed.hall : null;
    const status = VALID_STATUSES.includes(parsed.status as any) ? parsed.status! : "area";

    return { wing, room, hall, status };
  } catch {
    return { wing: defaultWing, room: "context", hall: null, status: "area" };
  }
}

// ── Query entity extraction ─────────────────────────────────────────────

const EXTRACT_PROMPT = `Extract the main entities from this user query. Return a JSON object with:
- "wings": array of wing identifiers this query is about (e.g. ["user"], ["person:juan", "user"], ["project:blog"])
- "room": optional room filter if the query targets a specific memory type (e.g. "preferences", "facts", "events") or null

Use the same wing format: "user", "person:<name>", "project:<name>", "place:<name>", "company:<name>", "pet:<name>", "product:<name>", "general".
Only include wings that are clearly referenced. Use lowercase names.

Query: {query}

JSON:`;

/**
 * Extract entity wings and optional room filter from a user query.
 * Used to focus vector search on relevant wings.
 */
export async function extractQueryEntities(query: string): Promise<{ wings: string[]; room: string | null }> {
  if (!llmConfig) return { wings: [], room: null };

  try {
    const prompt = EXTRACT_PROMPT.replace("{query}", query.slice(0, 300));
    const text = await quickPrompt(llmConfig, prompt, 80);

    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return { wings: [], room: null };

    const parsed = JSON.parse(jsonMatch[0]) as { wings?: string[]; room?: string | null };
    const wings = Array.isArray(parsed.wings)
      ? parsed.wings.filter((w): w is string => typeof w === "string").map((w) => w.toLowerCase().trim())
      : [];
    const room = parsed.room && VALID_ROOMS.includes(parsed.room as any) ? parsed.room : null;

    return { wings, room };
  } catch {
    return { wings: [], room: null };
  }
}

/**
 * Store an embedding vector with palace metadata.
 * If room/hall are not provided, auto-classifies from content.
 */
export async function storeVector(
  messageId: number,
  content: string,
  wing: string = "general",
  room?: string,
  hall?: string,
  role: string = "user",
): Promise<void> {
  let status: string = "area";
  // Auto-classify using LLM if not explicitly set
  if (!room) {
    const classified = await classifyContent(content, role);
    wing = classified.wing;
    room = classified.room;
    hall = hall ?? classified.hall ?? undefined;
    status = classified.status;
  }

  const embedding = await getEmbedding(content);
  const d = getDb();
  d.run(
    "INSERT INTO memory_vectors (message_id, wing, room, hall, status, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [messageId, wing, room, hall ?? null, status, vectorToBlob(embedding), Date.now()],
  );
}

/**
 * Semantic search: embed query, compute cosine similarity against stored vectors.
 * Optionally filter by wing/room before scoring.
 */
export async function searchSemantic(
  query: string,
  topK: number = 5,
  filters?: { wing?: string; wings?: string[]; room?: string; status?: string; includeArchived?: boolean },
): Promise<VectorSearchResult[]> {
  const queryEmbedding = await getEmbedding(query);
  const d = getDb();

  let sql = "SELECT id, message_id, wing, room, hall, status, embedding FROM memory_vectors";
  const conditions: string[] = [];
  const params: string[] = [];

  if (filters?.wings && filters.wings.length > 0) {
    conditions.push(`wing IN (${filters.wings.map(() => "?").join(",")})`);
    params.push(...filters.wings);
  } else if (filters?.wing) {
    conditions.push("wing = ?");
    params.push(filters.wing);
  }
  if (filters?.room) {
    conditions.push("room = ?");
    params.push(filters.room);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  } else if (!filters?.includeArchived) {
    // Exclude archived by default unless explicitly requested
    conditions.push("status != 'archive'");
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  const rows = d.query(sql).all(...params) as {
    id: number;
    message_id: number;
    wing: string;
    room: string;
    hall: string | null;
    status: string;
    embedding: Buffer;
  }[];

  const scored: VectorSearchResult[] = [];
  for (const row of rows) {
    const vec = blobToVector(row.embedding);
    const score = cosineSimilarity(queryEmbedding, vec);
    scored.push({
      messageId: row.message_id,
      wing: row.wing,
      room: row.room,
      hall: row.hall,
      status: row.status,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Update wing/room/hall/status metadata on an existing vector entry.
 */
export function categorizeMemory(
  vectorId: number,
  wing: string,
  room: string,
  hall?: string,
  status?: string,
): boolean {
  const d = getDb();
  const result = d.run(
    "UPDATE memory_vectors SET wing = ?, room = ?, hall = ?, status = ? WHERE id = ?",
    [wing, room, hall ?? null, status ?? "area", vectorId],
  );
  return result.changes > 0;
}

/**
 * Bulk-update the status of all vectors matching a wing (and optionally room).
 * Used to mark projects as complete/cancelled (→ "archive"), or activate areas
 * into projects when user commits to them.
 */
export function updateStatus(
  wing: string,
  newStatus: string,
  room?: string,
): number {
  const d = getDb();
  if (!VALID_STATUSES.includes(newStatus as any)) {
    throw new Error(`Invalid status: ${newStatus}. Valid: ${VALID_STATUSES.join(", ")}`);
  }
  let sql = "UPDATE memory_vectors SET status = ? WHERE wing = ?";
  const params: string[] = [newStatus, wing];
  if (room) {
    sql += " AND room = ?";
    params.push(room);
  }
  const result = d.run(sql, params);
  return result.changes;
}

/**
 * Complete a project with PARA-style transition using semantic similarity.
 *
 * Uses a project description (e.g., "trip to Japan June 2026") to find
 * vectors semantically related to the project, then:
 *   - Events, decisions, and requests tied to the project → archive
 *   - Resources (lists, references, how-tos) generated inside the project → keep as "resource"
 *     so they remain discoverable even after the project ends
 *
 * Only vectors with cosine similarity above `threshold` and the right hall/status
 * are affected. Other concurrent projects in the same hall are untouched.
 */
export async function completeProject(
  projectDescription: string,
  options: {
    hall?: string;
    threshold?: number;
    archiveRooms?: string[];
  } = {},
): Promise<{ archived: number; keptAsResource: number; scanned: number }> {
  const hall = options.hall;
  const threshold = options.threshold ?? 0.55;
  const archiveRooms = options.archiveRooms ?? ["events", "decisions", "requests", "answers", "suggestions"];

  const d = getDb();
  const queryEmbedding = await getEmbedding(projectDescription);

  // Load all project-status vectors (optionally filtered by hall)
  let sql = "SELECT id, room, hall, embedding FROM memory_vectors WHERE status = 'project'";
  const params: string[] = [];
  if (hall) {
    sql += " AND hall = ?";
    params.push(hall);
  }
  const rows = d.query(sql).all(...params) as {
    id: number;
    room: string;
    hall: string;
    embedding: Buffer;
  }[];

  const archiveSet = new Set(archiveRooms);
  let archived = 0;
  let keptAsResource = 0;

  for (const row of rows) {
    const vec = blobToVector(row.embedding);
    const score = cosineSimilarity(queryEmbedding, vec);
    if (score < threshold) continue;

    if (archiveSet.has(row.room)) {
      d.run("UPDATE memory_vectors SET status = 'archive' WHERE id = ?", [row.id]);
      archived++;
    } else {
      d.run("UPDATE memory_vectors SET status = 'resource' WHERE id = ?", [row.id]);
      keptAsResource++;
    }
  }

  return { archived, keptAsResource, scanned: rows.length };
}

/**
 * Backfill embeddings for messages that don't have vectors yet.
 * Reads message IDs from memory.db, compares with knowledge.db.
 * Runs in batches to avoid blocking.
 */
export async function migrateEmbeddings(
  memoryDbPath: string,
  batchSize: number = 50,
): Promise<number> {
  const kdb = getDb();
  const mdb = new Database(memoryDbPath);
  mdb.run("PRAGMA busy_timeout=5000");

  // Get message IDs that already have vectors
  const existing = new Set(
    (kdb.query("SELECT message_id FROM memory_vectors").all() as { message_id: number }[])
      .map((r) => r.message_id),
  );

  // Get all messages from memory.db
  const messages = mdb.query(
    "SELECT id, session_id, role, content FROM messages ORDER BY id",
  ).all() as { id: number; session_id: string; role: string; content: string }[];

  mdb.close();

  const toMigrate = messages.filter((m) => !existing.has(m.id));
  if (toMigrate.length === 0) return 0;

  logger.info(`Migrating ${toMigrate.length} messages to vector memory...`);

  let migrated = 0;
  for (let i = 0; i < toMigrate.length; i += batchSize) {
    const batch = toMigrate.slice(i, i + batchSize);
    for (const msg of batch) {
      try {
        await storeVector(msg.id, msg.content, "general", undefined, undefined, msg.role);
        migrated++;
      } catch (err) {
        logger.warn(`Failed to embed message #${msg.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (i + batchSize < toMigrate.length) {
      // Yield to event loop between batches
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  logger.info(`Migrated ${migrated}/${toMigrate.length} messages to vector memory`);
  return migrated;
}

/**
 * Stats for monitoring.
 */
export function vectorStats(): { totalVectors: number; byWing: Record<string, number> } {
  const d = getDb();
  const total = (d.query("SELECT COUNT(*) as count FROM memory_vectors").get() as { count: number }).count;
  const wings = d.query("SELECT wing, COUNT(*) as count FROM memory_vectors GROUP BY wing").all() as { wing: string; count: number }[];
  const byWing: Record<string, number> = {};
  for (const w of wings) {
    byWing[w.wing] = w.count;
  }
  return { totalVectors: total, byWing };
}
