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
}

export interface CreateJobOptions {
  name: string;
  type: "once" | "cron";
  schedule?: string;
  prompt: string;
  execution_type?: "prompt" | "shell";
  delay?: string;
  on_complete_shortcut?: string;
  on_complete_data?: Record<string, unknown>;
}

// ── Database ─────────────────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");

  db.run(`
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
      on_complete_data TEXT
    )
  `);

  // Migration: add columns if upgrading from older schema
  try { db.run("ALTER TABLE jobs ADD COLUMN on_complete_shortcut TEXT"); } catch {}
  try { db.run("ALTER TABLE jobs ADD COLUMN on_complete_data TEXT"); } catch {}

  return db;
}

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

export function initJobs(): void {
  const d = getDb();

  // Recover jobs stuck in 'running' from a previous crash/restart
  const stuck = d.run("UPDATE jobs SET status = 'pending' WHERE status = 'running'");
  if (stuck.changes > 0) {
    console.log(`Recovered ${stuck.changes} stuck job(s) from 'running' → 'pending'.`);
  }

  console.log("Jobs system initialized.");
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

  const result = d.run(
    `INSERT INTO jobs (name, type, schedule, prompt, execution_type, status, created_at, next_run_at, on_complete_shortcut, on_complete_data)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [opts.name, opts.type, opts.schedule ?? null, opts.prompt, executionType, now, nextRunAt, opts.on_complete_shortcut ?? null, onCompleteData],
  );

  return getJob(Number(result.lastInsertRowid))!;
}

export function getJob(id: number): Job | null {
  const d = getDb();
  return d.query("SELECT * FROM jobs WHERE id = ?").get(id) as Job | null;
}

export function listJobs(): Job[] {
  const d = getDb();
  return d.query("SELECT * FROM jobs ORDER BY created_at DESC").all() as Job[];
}

export function deleteJob(id: number): boolean {
  const d = getDb();
  const result = d.run("DELETE FROM jobs WHERE id = ?", [id]);
  return result.changes > 0;
}

export function updateJobEnabled(id: number, enabled: boolean): boolean {
  const d = getDb();
  const result = d.run("UPDATE jobs SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  return result.changes > 0;
}

// ── Polling integration ──────────────────────────────────────────────────

export function hasUndeliveredResults(): boolean {
  const d = getDb();
  const row = d.query(
    "SELECT COUNT(*) as count FROM jobs WHERE (status = 'completed' OR status = 'failed') AND delivered = 0",
  ).get() as { count: number };
  return row.count > 0;
}

export function getUndeliveredResults(): Job[] {
  const d = getDb();
  return d.query(
    "SELECT * FROM jobs WHERE (status = 'completed' OR status = 'failed') AND delivered = 0 ORDER BY completed_at ASC",
  ).all() as Job[];
}

export function markDelivered(ids: number[]): void {
  if (ids.length === 0) return;
  const d = getDb();
  const placeholders = ids.map(() => "?").join(",");
  d.run(`UPDATE jobs SET delivered = 1 WHERE id IN (${placeholders})`, ids);
}

// ── Job execution ────────────────────────────────────────────────────────

function executeShell(command: string, cwd: string, timeoutMs: number = 60_000): Promise<{ ok: boolean; output: string }> {
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

type SchedulerChatFn = (prompt: string) => Promise<string>;

export function startScheduler(workingDir: string, chatFn?: SchedulerChatFn): void {
  schedulerConfig = { workingDir, chatFn };

  // Run scheduler tick every 60 seconds
  schedulerInterval = setInterval(() => {
    schedulerTick().catch((err) => {
      console.error("Scheduler tick error:", err instanceof Error ? err.message : err);
    });
  }, 60_000);

  // Also run once after 5 seconds to pick up any immediately due jobs
  setTimeout(() => {
    schedulerTick().catch((err) => {
      console.error("Scheduler initial tick error:", err instanceof Error ? err.message : err);
    });
  }, 5_000);

  console.log("Job scheduler started (60s tick).");
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("Job scheduler stopped.");
  }
}

async function schedulerTick(): Promise<void> {
  if (!schedulerConfig) return;

  const d = getDb();
  const now = Date.now();

  const dueJobs = d.query(
    "SELECT * FROM jobs WHERE enabled = 1 AND status = 'pending' AND next_run_at <= ? ORDER BY next_run_at ASC",
  ).all(now) as Job[];

  for (const job of dueJobs) {
    // Mark as running
    d.run("UPDATE jobs SET status = 'running' WHERE id = ?", [job.id]);
    console.log(`[Job #${job.id}] Running "${job.name}" (${job.execution_type})...`);

    try {
      let output: string;
      let ok: boolean;

      if (job.execution_type === "shell") {
        const result = await executeShell(job.prompt, schedulerConfig.workingDir);
        output = result.output;
        ok = result.ok;
      } else if (job.execution_type === "prompt" && schedulerConfig.chatFn) {
        try {
          output = await schedulerConfig.chatFn(job.prompt);
          ok = true;
        } catch (err) {
          output = err instanceof Error ? err.message : String(err);
          ok = false;
        }
      } else {
        output = "No execution handler available for type: " + job.execution_type;
        ok = false;
      }

      const completedAt = Date.now();

      if (ok) {
        console.log(`[Job #${job.id}] Completed successfully.`);
      } else {
        console.log(`[Job #${job.id}] Failed: ${output.slice(0, 100)}`);
      }

      const resultField = ok ? "result" : "error";

      if (job.type === "cron" && job.schedule) {
        // Reschedule cron job
        const nextRun = nextRunFromSchedule(job.schedule, new Date(completedAt));
        if (nextRun) {
          d.run(
            `UPDATE jobs SET status = 'pending', ${resultField} = ?, completed_at = ?, next_run_at = ?, delivered = 0 WHERE id = ?`,
            [output || null, completedAt, nextRun, job.id],
          );
        } else {
          // Schedule couldn't be resolved — mark as failed
          d.run(
            "UPDATE jobs SET status = 'failed', error = ?, completed_at = ?, delivered = 0 WHERE id = ?",
            ["Could not calculate next run time from schedule: " + job.schedule, completedAt, job.id],
          );
        }
      } else {
        d.run(
          `UPDATE jobs SET status = '${ok ? "completed" : "failed"}', ${resultField} = ?, completed_at = ?, delivered = 0 WHERE id = ?`,
          [output || null, completedAt, job.id],
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Job #${job.id}] Unexpected error: ${msg}`);
      d.run(
        "UPDATE jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
        [msg, Date.now(), job.id],
      );
    }
  }
}
