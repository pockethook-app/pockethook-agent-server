import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureJobsSchema, createIntentJob, initJobs, deleteJob, IntentJobConflictError } from "../src/jobs.js";
import { pendingDeliveries, captureDeliveries, acknowledgeDeliveries, acknowledgeLegacyJobs } from "../src/deliveries.js";
import { deliveryResponses } from "../src/job-results.js";

function database() {
  const db = new Database(":memory:");
  ensureJobsSchema(db);
  return db;
}

test("an unacknowledged response is replayed with stable message identities", () => {
  const db = database();
  try {
    const { job } = createIntentJob({ requestId: "fixture-request", sessionId: "fixture-session", prompt: "hello" }, db);
    db.run("UPDATE jobs SET status='completed', result=?, completed_at=1 WHERE id=?",
      [JSON.stringify([{ msg: "one" }, { msg: "two", shortcut: "FixtureShortcut" }]), job.id]);
    const first = pendingDeliveries(db)[0]!;
    const replay = pendingDeliveries(db)[0]!;
    expect(replay.id).toBe(first.id);
    expect(deliveryResponses(replay)).toEqual(deliveryResponses(first));
    expect(deliveryResponses(first)[0]?.deliveryCount).toBe(2);
    expect(new Set(deliveryResponses(first).map((r) => r.messageId)).size).toBe(2);
    acknowledgeDeliveries(db, [first.id, first.id, "unknown"]);
    expect(pendingDeliveries(db)).toHaveLength(0);
    expect((db.query("SELECT delivered FROM jobs WHERE id=?").get(job.id) as any).delivered).toBe(1);
  } finally { db.close(); }
});

test("acknowledging an older recurring result leaves its newer run pending", () => {
  const db = database();
  try {
    const { job } = createIntentJob({ requestId: "recurring-fixture", sessionId: "fixture-session", prompt: "hello" }, db);
    db.run("UPDATE jobs SET type='cron', status='pending', result='first', completed_at=1 WHERE id=?", [job.id]);
    const first = pendingDeliveries(db)[0]!;
    db.run("UPDATE jobs SET result='second', completed_at=2 WHERE id=?", [job.id]);
    captureDeliveries(db);
    acknowledgeDeliveries(db, [first.id]);
    expect(pendingDeliveries(db).map((d) => d.job.result)).toEqual(["second"]);
    expect((db.query("SELECT delivered FROM jobs WHERE id=?").get(job.id) as any).delivered).toBe(0);
    acknowledgeLegacyJobs(db, [job.id]);
    expect(pendingDeliveries(db)).toHaveLength(0);
  } finally { db.close(); }
});

test("shared requests persist once and interrupted shared actions do not restart", () => {
  const db = database();
  try {
    const options = { requestId: "shared-fixture", sessionId: "fixture-session", prompt: "hello", origin: "share" as const };
    const first = createIntentJob(options, db);
    expect(createIntentJob(options, db).created).toBe(false);
    expect(() => createIntentJob({ ...options, silent: true }, db)).toThrow(IntentJobConflictError);
    db.run("UPDATE jobs SET status='running' WHERE id=?", [first.job.id]);
    initJobs(db);
    const job = db.query("SELECT status,error FROM jobs WHERE id=?").get(first.job.id) as any;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("outcome unknown");
  } finally { db.close(); }
});

test("deleting a job also removes its pending delivery snapshots", () => {
  const db = database();
  try {
    const { job } = createIntentJob({ requestId: "delete-fixture", sessionId: "fixture-session", prompt: "hello" }, db);
    db.run("UPDATE jobs SET status='completed',result='fixture',completed_at=1 WHERE id=?", [job.id]);
    expect(pendingDeliveries(db)).toHaveLength(1);
    expect(deleteJob(job.id, db)).toBe(true);
    expect(pendingDeliveries(db)).toHaveLength(0);
  } finally { db.close(); }
});
