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
}

export interface CreateJobOptions {
  name: string;
  type: "once" | "cron";
  schedule?: string;
  prompt: string;
  execution_type?: "prompt" | "shell";
  delay?: string;
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
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

  return db;
}

// ── Schedule parsing ─────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseInterval(input: string): number | null {
  const match = input.trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (value <= 0) return null;
  return value * (UNITS[unit] ?? 0);
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export function initJobs(): void {
  getDb();
  console.log("Jobs system initialized.");
}

export function createJob(opts: CreateJobOptions): Job {
  const d = getDb();
  const now = Date.now();

  if (opts.type === "cron" && !opts.schedule) {
    throw new Error("Cron jobs require a schedule (e.g., '5m', '1h', '1d')");
  }

  if (opts.schedule) {
    const ms = parseInterval(opts.schedule);
    if (!ms) throw new Error(`Invalid schedule format: ${opts.schedule}. Use: 30s, 5m, 1h, 1d`);
  }

  let delayMs = 0;
  if (opts.delay) {
    const ms = parseInterval(opts.delay);
    if (!ms) throw new Error(`Invalid delay format: ${opts.delay}. Use: 30s, 5m, 1h, 1d`);
    delayMs = ms;
  }

  const nextRunAt = now + delayMs;
  const executionType = opts.execution_type ?? "shell";

  const result = d.run(
    `INSERT INTO jobs (name, type, schedule, prompt, execution_type, status, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [opts.name, opts.type, opts.schedule ?? null, opts.prompt, executionType, now, nextRunAt],
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
    "SELECT * FROM jobs WHERE enabled = 1 AND status != 'running' AND next_run_at <= ? ORDER BY next_run_at ASC",
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
        if (job.type === "cron" && job.schedule) {
          // Reschedule cron job
          const intervalMs = parseInterval(job.schedule)!;
          d.run(
            "UPDATE jobs SET status = 'pending', result = ?, completed_at = ?, next_run_at = ?, delivered = 0 WHERE id = ?",
            [output || null, completedAt, completedAt + intervalMs, job.id],
          );
        } else {
          d.run(
            "UPDATE jobs SET status = 'completed', result = ?, completed_at = ?, delivered = 0 WHERE id = ?",
            [output || null, completedAt, job.id],
          );
        }
      } else {
        console.log(`[Job #${job.id}] Failed: ${output.slice(0, 100)}`);
        if (job.type === "cron" && job.schedule) {
          const intervalMs = parseInterval(job.schedule)!;
          d.run(
            "UPDATE jobs SET status = 'pending', error = ?, completed_at = ?, next_run_at = ?, delivered = 0 WHERE id = ?",
            [output || null, completedAt, completedAt + intervalMs, job.id],
          );
        } else {
          d.run(
            "UPDATE jobs SET status = 'failed', error = ?, completed_at = ?, delivered = 0 WHERE id = ?",
            [output || null, completedAt, job.id],
          );
        }
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
