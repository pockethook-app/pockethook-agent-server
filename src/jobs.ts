/**
 * Background job system with cron scheduling.
 *
 * Jobs are stored in SQLite (same data/memory.db) and executed
 * by a scheduler that ticks every 60 seconds.
 *
 * Two execution types:
 * - "shell": runs a bash command, captures stdout/stderr
 * - "prompt": sends a prompt through the AI agent pipeline
 */

import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync } from "fs";
import { loadPermissions, checkShellPermission } from "./permissions.js";
import { logger } from "./logger.js";
import { RunTimeoutError, withTimeout } from "./abort.js";
import { ensureDeliverySchema, captureDeliveries, pendingDeliveries, deliveryForJob, acknowledgeDeliveries, acknowledgeLegacyJobs } from "./deliveries.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(PROJECT_ROOT, "data");
const DB_PATH = join(DATA_DIR, "memory.db");

// ── Types ────────────────────────────────────────────────────────────────

export interface Job {
  id: number;
  name: string;
  type: "once" | "cron";
  schedule: string | null;
  prompt: string;
  execution_type: "prompt" | "shell";
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  next_run_at: number;
  delivered: number;
  enabled: number;
  on_complete_shortcut: string | null;
  on_complete_data: string | null;
  retries: number;
  silent: number;
  timeout_ms: number | null;
  request_id: string | null;
  session_id: string | null;
  origin: string | null;
}

export interface CreateJobOptions {
  name: string;
  type: "once" | "cron";
  schedule?: string;
  prompt: string;
  execution_type?: "prompt" | "shell";
  delay?: string;
  timeout?: string;
  silent?: boolean;
  on_complete_shortcut?: string;
  on_complete_data?: Record<string, unknown>;
}

export interface CreateIntentJobOptions {
  requestId: string;
  sessionId: string;
  prompt: string;
  silent?: boolean;
  origin?: "app_intent" | "share";
}

export interface CreateIntentJobResult {
  job: Job;
  created: boolean;
}

export class IntentJobConflictError extends Error {
  constructor() {
    super("The request id is already associated with different content");
    this.name = "IntentJobConflictError";
  }
}

// ── Database ─────────────────────────────────────────────────────────────

let db: Database | null = null;

/** Create or migrate the jobs schema. Exported so migrations can be tested in memory. */
export function ensureJobsSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('once', 'cron')),
      schedule TEXT,
      prompt TEXT NOT NULL,
      execution_type TEXT NOT NULL DEFAULT 'shell' CHECK(execution_type IN ('prompt', 'shell')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      next_run_at INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      on_complete_shortcut TEXT,
      on_complete_data TEXT,
      silent INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER,
      retries INTEGER NOT NULL DEFAULT 0,
      request_id TEXT,
      session_id TEXT,
      origin TEXT
    )
  `);

  // Additive, backwards-compatible migrations for existing installations.
  try { database.run("ALTER TABLE jobs ADD COLUMN on_complete_shortcut TEXT"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN on_complete_data TEXT"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN silent INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN timeout_ms INTEGER"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN request_id TEXT"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN session_id TEXT"); } catch {}
  try { database.run("ALTER TABLE jobs ADD COLUMN origin TEXT"); } catch {}
  database.run("CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_id_unique ON jobs(request_id) WHERE request_id IS NOT NULL");
  ensureDeliverySchema(database);
}

function getDb(): Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");

  const existingColumns = db.query("PRAGMA table_info(jobs)").all() as { name: string }[];
  const existingNames = new Set(existingColumns.map((column) => column.name));
  const needsIntentMigration = existingColumns.length > 0 &&
    ["request_id", "session_id", "origin"].some((column) => !existingNames.has(column));

  if (needsIntentMigration) {
    const backupDir = join(DATA_DIR, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(backupDir, `memory-before-intent-jobs-${stamp}.db`);
    db.run("PRAGMA wal_checkpoint(FULL)");
    db.run(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    logger.info("Created pre-migration database backup", { path: backupPath });
  }

  const migrate = db.transaction(() => ensureJobsSchema(db!));
  migrate();

  return db;
}

const MAX_RETRIES = 2;
const RETRY_DELAYS = [60_000, 300_000]; // 1 min, 5 min

// ── Schedule parsing ─────────────────────────────────────────────────────

// Simple intervals: 30s, 5m, 1h, 1d, 2w
const INTERVAL_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseInterval(input: string): number | null {
  const match = input.trim().match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (value <= 0) return null;
  return value * (INTERVAL_UNITS[unit] ?? 0);
}

/** Returns true if the schedule string is a simple interval (5m, 1h, etc.) */
export function isInterval(schedule: string): boolean {
  return /^\d+(s|m|h|d|w)$/i.test(schedule.trim());
}

// ── Cron expression parser ───────────────────────────────────────────────
// Format: minute hour day-of-month month day-of-week
// Supports: *, ranges (1-5), steps (*/5, 1-10/2), lists (1,3,5)
// Day names: SUN=0, MON=1, ..., SAT=6
// Month names: JAN=1, ..., DEC=12

const DAY_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function parseField(field: string, min: number, max: number, names?: Record<string, number>): Set<number> | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    let token = part.trim().toUpperCase();

    // Replace names with numbers
    if (names) {
      for (const [name, num] of Object.entries(names)) {
        token = token.replace(new RegExp(`\\b${name}\\b`, "g"), String(num));
      }
    }

    // */step
    const stepAll = token.match(/^\*\/(\d+)$/);
    if (stepAll) {
      const step = parseInt(stepAll[1]!, 10);
      if (step <= 0) return null;
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }

    // *
    if (token === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // range/step: 1-10/2
    const rangeStep = token.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStep) {
      const start = parseInt(rangeStep[1]!, 10);
      const end = parseInt(rangeStep[2]!, 10);
      const step = parseInt(rangeStep[3]!, 10);
      if (start < min || end > max || step <= 0) return null;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // range: 1-5
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1]!, 10);
      const end = parseInt(range[2]!, 10);
      if (start < min || end > max) return null;
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // single number
    const num = parseInt(token, 10);
    if (isNaN(num) || num < min || num > max) return null;
    values.add(num);
  }

  return values.size > 0 ? values : null;
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minutes = parseField(parts[0]!, 0, 59);
  const hours = parseField(parts[1]!, 0, 23);
  const daysOfMonth = parseField(parts[2]!, 1, 31);
  const months = parseField(parts[3]!, 1, 12, MONTH_NAMES);
  const daysOfWeek = parseField(parts[4]!, 0, 6, DAY_NAMES);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Calculate next run time from a cron expression.
 * Searches up to 2 years ahead to find a match.
 */
export function nextCronDate(expression: string, after: Date = new Date()): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;

  // Start from the next minute
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Search up to ~2 years (enough for any valid cron)
  const maxIterations = 366 * 24 * 60; // ~1 year in minutes
  for (let i = 0; i < maxIterations; i++) {
    if (
      fields.months.has(d.getMonth() + 1) &&
      fields.daysOfMonth.has(d.getDate()) &&
      fields.daysOfWeek.has(d.getDay()) &&
      fields.hours.has(d.getHours()) &&
      fields.minutes.has(d.getMinutes())
    ) {
      return d;
    }
    d.setMinutes(d.getMinutes() + 1);
  }

  return null; // No match found
}

/**
 * Calculate next run time from a schedule string.
 * Supports both simple intervals (5m, 1h) and cron expressions (0 9 * * MON).
 */
export function nextRunFromSchedule(schedule: string, after: Date = new Date()): number | null {
  if (isInterval(schedule)) {
    const ms = parseInterval(schedule);
    return ms ? after.getTime() + ms : null;
  }
  const next = nextCronDate(schedule, after);
  return next ? next.getTime() : null;
}

/**
 * Validate a schedule string (interval or cron expression).
 */
export function validateSchedule(schedule: string): { valid: boolean; error?: string } {
  if (isInterval(schedule)) {
    const ms = parseInterval(schedule);
    return ms ? { valid: true } : { valid: false, error: `Invalid interval: ${schedule}. Use: 30s, 5m, 1h, 1d, 2w` };
  }
  const fields = parseCron(schedule);
  if (!fields) {
    return { valid: false, error: `Invalid schedule: ${schedule}. Use interval (5m, 1h, 1d, 2w) or cron expression (0 9 * * MON)` };
  }
  return { valid: true };
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export function initJobs(database: Database = getDb()): void {
  ensureJobsSchema(database);

  // Retrying an intent after the agent started could duplicate external tool
  // side effects. Surface an unknown outcome instead; ordinary jobs retain
  // their historical restart/retry behaviour.
  const uncertain = database.run(
    `UPDATE jobs
     SET status = 'failed', error = 'Server restarted while this request was running; outcome unknown',
         completed_at = ?, enabled = 0, delivered = CASE WHEN silent = 1 THEN 1 ELSE 0 END
     WHERE status = 'running' AND origin IN ('app_intent', 'share')`,
    [Date.now()],
  );
  if (uncertain.changes > 0) {
    logger.warn(`Marked ${uncertain.changes} interrupted intent job(s) as outcome unknown`);
  }

  const stuck = database.run("UPDATE jobs SET status = 'pending' WHERE status = 'running'");
  if (stuck.changes > 0) {
    logger.warn(`Recovered ${stuck.changes} ordinary job(s) from 'running' → 'pending'`);
  }

  logger.info("Jobs system initialized");
}

export function createJob(opts: CreateJobOptions): Job {
  const d = getDb();
  const now = Date.now();

  if (opts.type === "cron" && !opts.schedule) {
    throw new Error("Cron jobs require a schedule (e.g., '5m', '1h', '0 9 * * MON')");
  }

  if (opts.schedule) {
    const check = validateSchedule(opts.schedule);
    if (!check.valid) throw new Error(check.error);
  }

  let delayMs = 0;
  if (opts.delay) {
    const ms = parseInterval(opts.delay);
    if (!ms) throw new Error(`Invalid delay format: ${opts.delay}. Use: 30s, 5m, 1h, 1d, 2w`);
    delayMs = ms;
  }

  let nextRunAt: number;
  if (delayMs > 0) {
    nextRunAt = now + delayMs;
  } else if (opts.schedule && !isInterval(opts.schedule)) {
    // Cron expression: calculate first run time
    nextRunAt = nextRunFromSchedule(opts.schedule, new Date(now)) ?? now;
  } else {
    nextRunAt = now;
  }
  const executionType = opts.execution_type ?? "shell";

  const onCompleteData = opts.on_complete_data ? JSON.stringify(opts.on_complete_data) : null;
  const silent = opts.silent ? 1 : 0;

  let timeoutMs: number | null = null;
  if (opts.timeout) {
    const ms = parseInterval(opts.timeout);
    if (!ms) throw new Error(`Invalid timeout format: ${opts.timeout}. Use: 30s, 5m, 1h, 1d`);
    timeoutMs = ms;
  }

  const result = d.run(
    `INSERT INTO jobs (name, type, schedule, prompt, execution_type, status, created_at, next_run_at, on_complete_shortcut, on_complete_data, silent, timeout_ms)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [opts.name, opts.type, opts.schedule ?? null, opts.prompt, executionType, now, nextRunAt, opts.on_complete_shortcut ?? null, onCompleteData, silent, timeoutMs],
  );

  return getJob(Number(result.lastInsertRowid))!;
}

/** Persist an App Intent request before acknowledging it to the phone. */
export function createIntentJob(
  opts: CreateIntentJobOptions,
  database: Database = getDb(),
): CreateIntentJobResult {
  ensureJobsSchema(database);
  const origin = opts.origin ?? "app_intent";
  const requestId = opts.requestId.trim();
  const sessionId = opts.sessionId.trim();
  if (!requestId || requestId.length > 128) throw new Error("Invalid request id");
  if (!sessionId || sessionId.length > 256) throw new Error("Invalid session id");

  const existing = database.query("SELECT * FROM jobs WHERE request_id = ?").get(requestId) as Job | null;
  if (existing) {
    if (existing.session_id !== sessionId || existing.prompt !== opts.prompt || existing.origin !== origin || existing.silent !== (opts.silent ? 1 : 0)) {
      throw new IntentJobConflictError();
    }
    return { job: existing, created: false };
  }

  const now = Date.now();
  const preview = opts.prompt.replace(/\s+/g, " ").trim();
  const name = `${origin === "share" ? "Shared" : "Intent"}: ${preview.length > 60 ? `${preview.slice(0, 57)}…` : preview}`;
  try {
    const result = database.run(
      `INSERT INTO jobs
       (name, type, schedule, prompt, execution_type, status, created_at, next_run_at,
        delivered, enabled, silent, retries, request_id, session_id, origin)
       VALUES (?, 'once', NULL, ?, 'prompt', 'pending', ?, ?, 0, 1, ?, 0, ?, ?, ?)`,
      [name, opts.prompt, now, now, opts.silent ? 1 : 0, requestId, sessionId, origin],
    );
    return { job: getJobFromDatabase(Number(result.lastInsertRowid), database)!, created: true };
  } catch (error) {
    // A concurrent duplicate may win the unique-index race between SELECT and INSERT.
    const duplicate = database.query("SELECT * FROM jobs WHERE request_id = ?").get(requestId) as Job | null;
    if (duplicate && duplicate.session_id === sessionId && duplicate.prompt === opts.prompt && duplicate.origin === origin && duplicate.silent === (opts.silent ? 1 : 0)) {
      return { job: duplicate, created: false };
    }
    throw error;
  }
}

function getJobFromDatabase(id: number, database: Database): Job | null {
  return database.query("SELECT * FROM jobs WHERE id = ?").get(id) as Job | null;
}

export function getJob(id: number): Job | null {
  return getJobFromDatabase(id, getDb());
}

export function getIntentJob(requestId: string): Job | null {
  return getDb().query("SELECT * FROM jobs WHERE request_id = ?").get(requestId) as Job | null;
}

export interface IntentJobStatus {
  requestId: string;
  status: Job["status"];
  delivered: boolean;
}

export function getIntentJobStatuses(
  requestIds: string[],
  database: Database = getDb(),
): IntentJobStatus[] {
  const uniqueIds = [...new Set(requestIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = database.query(
    `SELECT request_id, status, delivered FROM jobs
     WHERE origin = 'app_intent' AND request_id IN (${placeholders})`,
  ).all(...uniqueIds) as { request_id: string; status: Job["status"]; delivered: number }[];
  return rows.map((row) => ({
    requestId: row.request_id,
    status: row.status,
    delivered: row.delivered === 1,
  }));
}

export async function waitForIntentJob(requestId: string, timeoutMs: number): Promise<Job | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const job = getIntentJob(requestId);
    if (!job || job.status === "completed" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getIntentJob(requestId);
}

export function markJobDelivered(id: number): void {
  acknowledgeLegacyJobs(getDb(), [id]);
}

export function listJobs(): Job[] {
  const d = getDb();
  return d.query("SELECT * FROM jobs ORDER BY created_at DESC").all() as Job[];
}

export function deleteJob(id: number, d: Database = getDb()): boolean {
  return d.transaction(() => {
    d.run("DELETE FROM job_deliveries WHERE job_id = ?", [id]);
    return d.run("DELETE FROM jobs WHERE id = ?", [id]).changes > 0;
  })();
}

export function updateJobEnabled(id: number, enabled: boolean): boolean {
  const d = getDb();
  const result = d.run("UPDATE jobs SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  return result.changes > 0;
}

// ── Polling integration ──────────────────────────────────────────────────

/**
 * Queue an already-produced reply (e.g. from a Share Extension message
 * processed asynchronously) for delivery through the same channel as job
 * results: GET /jobs turns true, and fetchPendingTasks delivers it. The
 * result is PocketHook-response JSON, so delivery renders it raw (no job
 * prefix). status=completed + enabled=0 keeps the scheduler away from it.
 */
export function storeShareReply(name: string, userText: string, resultJson: string): number {
  const d = getDb();
  const now = Date.now();
  const res = d
    .prepare(
      `INSERT INTO jobs (name, type, schedule, prompt, execution_type, status, result, created_at, completed_at, next_run_at, delivered, enabled, silent)
       VALUES (?, 'once', NULL, ?, 'prompt', 'completed', ?, ?, ?, ?, 0, 0, 0)`,
    )
    .run(name, userText, resultJson, now, now, now);
  return Number(res.lastInsertRowid);
}

export function getPendingDeliveries() { return pendingDeliveries(getDb()); }
export function getDeliveryForJob(job: Job) { return deliveryForJob(getDb(), job); }
export function confirmDeliveries(ids: string[]) { acknowledgeDeliveries(getDb(), ids); }

export function hasUndeliveredResults(): boolean {
  return getPendingDeliveries().length > 0;
}

export function getUndeliveredResults(): Job[] {
  return getPendingDeliveries().map((delivery) => delivery.job);
}

export function markDelivered(ids: number[]): void {
  acknowledgeLegacyJobs(getDb(), ids);
}

export interface UndeliveredJobSummary {
  id: number;
  name: string;
  ok: boolean;
  completed_at: number | null;
}

// Lightweight view of undelivered jobs for the device's notification poll:
// just enough to dedupe by id and show a descriptive title — no result payload.
export function getUndeliveredJobSummaries(): UndeliveredJobSummary[] {
  const jobs = new Map(getUndeliveredResults().map((job) => [job.id, job]));
  return [...jobs.values()].map((job) => ({ id: job.id, name: job.name, ok: job.result != null,
    completed_at: job.completed_at }));
}

// ── Job execution ────────────────────────────────────────────────────────

function executeShell(command: string, cwd: string, timeoutMs: number = 60_000): Promise<{ ok: boolean; output: string }> {
  const perms = loadPermissions();
  const check = checkShellPermission(command, perms);
  if (!check.allowed) {
    return Promise.resolve({ ok: false, output: `Permission denied: ${check.reason}` });
  }

  return new Promise((res) => {
    let output = "";
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

    child.on("close", (code) => {
      res({ ok: code === 0, output: output.trim() });
    });

    child.on("error", (err) => {
      res({ ok: false, output: `Error: ${err.message}` });
    });
  });
}

// ── Scheduler ────────────────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let schedulerConfig: { workingDir: string; chatFn?: SchedulerChatFn } | null = null;
let schedulerRun: Promise<void> | null = null;
let schedulerRequested = false;

type SchedulerChatFn = (job: Job, signal: AbortSignal) => Promise<string>;

export function startScheduler(workingDir: string, chatFn?: SchedulerChatFn): void {
  schedulerConfig = { workingDir, chatFn };

  // Run scheduler tick every 60 seconds
  schedulerInterval = setInterval(triggerScheduler, 60_000);

  // Also run once after 5 seconds to pick up any immediately due jobs
  setTimeout(() => {
    triggerScheduler();
  }, 5_000);

  logger.info("Job scheduler started (60s tick)");
}

/** Wake the scheduler immediately while keeping all executions globally serial. */
export function triggerScheduler(): void {
  schedulerRequested = true;
  if (schedulerRun) return;

  schedulerRun = (async () => {
    while (schedulerRequested) {
      schedulerRequested = false;
      await schedulerTick();
    }
  })()
    .catch((err) => {
      logger.error("Scheduler tick error", { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      schedulerRun = null;
      if (schedulerRequested) triggerScheduler();
    });
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info("Job scheduler stopped");
  }
}

async function schedulerTick(): Promise<void> {
  if (!schedulerConfig) return;

  const d = getDb();
  const now = Date.now();

  captureDeliveries(d);
  const dueJobs = d.query(
    "SELECT * FROM jobs WHERE enabled = 1 AND status = 'pending' AND next_run_at <= ? ORDER BY next_run_at ASC",
  ).all(now) as Job[];

  for (const job of dueJobs) {
    // Atomically claim the job. setInterval fires ticks on a fixed cadence
    // without waiting for the previous tick to finish, so two overlapping
    // ticks can select the same pending job — the conditional UPDATE ensures
    // only one wins and the other skips it instead of double-running.
    const claim = d.run("UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'pending'", [job.id]);
    if (claim.changes === 0) continue;
    logger.info(`Job #${job.id} running`, { name: job.name, type: job.execution_type });

    try {
      let output: string;
      let ok: boolean;
      let timedOut = false;

      if (job.execution_type === "shell") {
        const jobTimeout = (job as any).timeout_ms ?? 60_000;
        const result = await executeShell(job.prompt, schedulerConfig.workingDir, jobTimeout);
        output = result.output;
        ok = result.ok;
      } else if (job.execution_type === "prompt" && schedulerConfig.chatFn) {
        try {
          const chatFn = schedulerConfig.chatFn;
          output = await withTimeout((signal) => chatFn(job, signal), job.timeout_ms ?? 30 * 60_000);
          ok = true;
        } catch (err) {
          output = err instanceof Error ? err.message : String(err);
          timedOut = err instanceof RunTimeoutError;
          ok = false;
        }
      } else {
        output = "No execution handler available for type: " + job.execution_type;
        ok = false;
      }

      const completedAt = Date.now();

      if (ok) {
        logger.info(`Job #${job.id} completed`);
      } else {
        logger.warn(`Job #${job.id} failed`, { output: output.slice(0, 200) });
      }

      const resultField = ok ? "result" : "error";
      // Silent jobs are auto-delivered so they don't trigger /jobs polling
      const deliveredFlag = (job as any).silent ? 1 : 0;

      if (job.type === "cron" && job.schedule) {
        // Reschedule cron job while preserving the latest run output for delivery.
        // Keep status pending so the scheduler can run again, but /jobs and
        // fetchPendingTasks must still see undelivered result/error payloads.
        const nextRun = nextRunFromSchedule(job.schedule, new Date(completedAt));
        if (nextRun) {
          d.run(
            `UPDATE jobs SET status = 'pending', ${resultField} = ?, ${resultField === "result" ? "error = NULL," : "result = NULL,"} completed_at = ?, next_run_at = ?, delivered = ? WHERE id = ?`,
            [output || null, completedAt, nextRun, deliveredFlag, job.id],
          );
        } else {
          // Schedule couldn't be resolved — mark as failed
          d.run(
            "UPDATE jobs SET status = 'failed', error = ?, completed_at = ?, delivered = ? WHERE id = ?",
            ["Could not calculate next run time from schedule: " + job.schedule, completedAt, deliveredFlag, job.id],
          );
        }
      } else if (!ok && !timedOut && job.type === "once" && job.origin !== "app_intent" && job.origin !== "share" && job.retries < MAX_RETRIES) {
        // Retry failed "once" jobs with exponential backoff
        const retryCount = ((job as any).retries ?? 0) + 1;
        const delay = RETRY_DELAYS[retryCount - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1]!;
        const nextRetry = completedAt + delay;
        logger.info(`Job #${job.id} scheduling retry ${retryCount}/${MAX_RETRIES}`, { delayMs: delay });
        d.run(
          "UPDATE jobs SET status = 'pending', error = ?, completed_at = ?, next_run_at = ?, retries = ? WHERE id = ?",
          [output || null, completedAt, nextRetry, retryCount, job.id],
        );
      } else {
        d.run(
          `UPDATE jobs SET status = '${ok ? "completed" : "failed"}', ${resultField} = ?, completed_at = ?, delivered = ? WHERE id = ?`,
          [output || null, completedAt, deliveredFlag, job.id],
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Job #${job.id} unexpected error`, { error: msg });
      d.run(
        "UPDATE jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
        [msg, Date.now(), job.id],
      );
    }
    captureDeliveries(d);
  }
}
