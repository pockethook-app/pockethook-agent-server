import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Job } from "./jobs.js";

export interface Delivery {
  id: string;
  job: Job;
}

export function ensureDeliverySchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS job_deliveries (
    id TEXT PRIMARY KEY, job_id INTEGER NOT NULL, completed_at INTEGER NOT NULL,
    payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
    UNIQUE(job_id, completed_at)
  )`);
}

/** Snapshot each result before another run can replace a recurring job's output. */
export function captureDeliveries(db: Database): void {
  ensureDeliverySchema(db);
  const jobs = db.query(`SELECT * FROM jobs WHERE delivered = 0 AND silent = 0
    AND (result IS NOT NULL OR error IS NOT NULL)`).all() as Job[];
  const insert = db.prepare(`INSERT OR IGNORE INTO job_deliveries
    (id, job_id, completed_at, payload) VALUES (?, ?, ?, ?)`);
  for (const job of jobs) {
    insert.run(randomUUID(), job.id, job.completed_at ?? 0, JSON.stringify(job));
  }
}

export function pendingDeliveries(db: Database): Delivery[] {
  captureDeliveries(db);
  const rows = db.query(`SELECT id, payload FROM job_deliveries WHERE acknowledged = 0
    ORDER BY completed_at, job_id`).all() as { id: string; payload: string }[];
  return rows.map((row) => ({ id: row.id, job: JSON.parse(row.payload) as Job }));
}

export function deliveryForJob(db: Database, job: Job): Delivery | undefined {
  captureDeliveries(db);
  const row = db.query(`SELECT id, payload FROM job_deliveries
    WHERE job_id = ? AND completed_at = ?`).get(job.id, job.completed_at ?? 0) as
    { id: string; payload: string } | null;
  return row ? { id: row.id, job: JSON.parse(row.payload) as Job } : undefined;
}

/** An old receipt must never acknowledge a newer run of the same cron job. */
export function acknowledgeDeliveries(db: Database, ids: string[]): void {
  const acknowledge = db.transaction(() => {
    for (const id of new Set(ids)) {
      const row = db.query("SELECT job_id, completed_at FROM job_deliveries WHERE id = ?")
        .get(id) as { job_id: number; completed_at: number } | null;
      if (!row) continue;
      db.run("UPDATE job_deliveries SET acknowledged = 1 WHERE id = ?", [id]);
      db.run("UPDATE jobs SET delivered = 1 WHERE id = ? AND COALESCE(completed_at, 0) = ?",
        [row.job_id, row.completed_at]);
    }
  });
  acknowledge();
}

export function acknowledgeLegacyJobs(db: Database, jobIds: number[]): void {
  if (jobIds.length === 0) return;
  captureDeliveries(db);
  const placeholders = jobIds.map(() => "?").join(",");
  db.run(`UPDATE job_deliveries SET acknowledged = 1 WHERE job_id IN (${placeholders})`, jobIds);
  db.run(`UPDATE jobs SET delivered = 1 WHERE id IN (${placeholders})`, jobIds);
}
