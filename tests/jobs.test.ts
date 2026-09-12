import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  parseInterval,
  isInterval,
  parseCron,
  nextCronDate,
  validateSchedule,
  nextRunFromSchedule,
  ensureJobsSchema,
  createIntentJob,
  initJobs,
  IntentJobConflictError,
  getIntentJobStatuses,
} from "../src/jobs.js";

describe("parseInterval", () => {
  test("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("1s")).toBe(1_000);
  });

  test("parses minutes", () => {
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("1m")).toBe(60_000);
  });

  test("parses hours", () => {
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("2h")).toBe(7_200_000);
  });

  test("parses days", () => {
    expect(parseInterval("1d")).toBe(86_400_000);
  });

  test("parses weeks", () => {
    expect(parseInterval("2w")).toBe(1_209_600_000);
  });

  test("returns null for invalid input", () => {
    expect(parseInterval("abc")).toBeNull();
    expect(parseInterval("")).toBeNull();
    expect(parseInterval("0m")).toBeNull();
    expect(parseInterval("-5m")).toBeNull();
    expect(parseInterval("5x")).toBeNull();
  });

  test("is case insensitive", () => {
    expect(parseInterval("5M")).toBe(300_000);
    expect(parseInterval("1H")).toBe(3_600_000);
  });
});

describe("isInterval", () => {
  test("recognizes intervals", () => {
    expect(isInterval("5m")).toBe(true);
    expect(isInterval("1h")).toBe(true);
    expect(isInterval("30s")).toBe(true);
    expect(isInterval("1d")).toBe(true);
    expect(isInterval("2w")).toBe(true);
  });

  test("rejects cron expressions", () => {
    expect(isInterval("0 9 * * MON")).toBe(false);
    expect(isInterval("*/5 * * * *")).toBe(false);
  });

  test("rejects invalid", () => {
    expect(isInterval("abc")).toBe(false);
    expect(isInterval("")).toBe(false);
  });
});

describe("parseCron", () => {
  test("parses simple cron", () => {
    const fields = parseCron("0 9 * * *");
    expect(fields).not.toBeNull();
    expect(fields!.minutes.has(0)).toBe(true);
    expect(fields!.hours.has(9)).toBe(true);
    expect(fields!.daysOfMonth.size).toBe(31);
    expect(fields!.months.size).toBe(12);
    expect(fields!.daysOfWeek.size).toBe(7);
  });

  test("parses day names", () => {
    const fields = parseCron("0 9 * * MON");
    expect(fields).not.toBeNull();
    expect(fields!.daysOfWeek.has(1)).toBe(true);
    expect(fields!.daysOfWeek.size).toBe(1);
  });

  test("parses step expressions", () => {
    const fields = parseCron("*/15 * * * *");
    expect(fields).not.toBeNull();
    expect(fields!.minutes.has(0)).toBe(true);
    expect(fields!.minutes.has(15)).toBe(true);
    expect(fields!.minutes.has(30)).toBe(true);
    expect(fields!.minutes.has(45)).toBe(true);
    expect(fields!.minutes.size).toBe(4);
  });

  test("parses ranges", () => {
    const fields = parseCron("0 9-17 * * *");
    expect(fields).not.toBeNull();
    expect(fields!.hours.size).toBe(9);
    expect(fields!.hours.has(9)).toBe(true);
    expect(fields!.hours.has(17)).toBe(true);
    expect(fields!.hours.has(8)).toBe(false);
  });

  test("parses lists", () => {
    const fields = parseCron("0,30 * * * *");
    expect(fields).not.toBeNull();
    expect(fields!.minutes.size).toBe(2);
    expect(fields!.minutes.has(0)).toBe(true);
    expect(fields!.minutes.has(30)).toBe(true);
  });

  test("returns null for invalid cron", () => {
    expect(parseCron("invalid")).toBeNull();
    expect(parseCron("0 25 * * *")).toBeNull(); // hour 25
    expect(parseCron("60 0 * * *")).toBeNull(); // minute 60
    expect(parseCron("")).toBeNull();
  });
});

describe("nextCronDate", () => {
  test("calculates next run for daily at 9am", () => {
    const after = new Date("2026-01-15T08:00:00Z");
    const next = nextCronDate("0 9 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });

  test("calculates next Monday", () => {
    const after = new Date("2026-01-15T10:00:00Z"); // Wednesday
    const next = nextCronDate("0 9 * * MON", after);
    expect(next).not.toBeNull();
    expect(next!.getDay()).toBe(1); // Monday
  });

  test("returns null for impossible schedules", () => {
    // Feb 30 doesn't exist, but with month=2, day=30 — should never match
    const result = nextCronDate("0 0 30 2 *");
    expect(result).toBeNull();
  });
});

describe("validateSchedule", () => {
  test("accepts valid intervals", () => {
    expect(validateSchedule("5m").valid).toBe(true);
    expect(validateSchedule("1h").valid).toBe(true);
  });

  test("accepts valid cron expressions", () => {
    expect(validateSchedule("0 9 * * *").valid).toBe(true);
    expect(validateSchedule("*/5 * * * *").valid).toBe(true);
    expect(validateSchedule("0 9 * * MON").valid).toBe(true);
  });

  test("rejects invalid schedules", () => {
    expect(validateSchedule("abc").valid).toBe(false);
    expect(validateSchedule("0 25 * * *").valid).toBe(false);
  });
});

describe("nextRunFromSchedule", () => {
  test("handles intervals", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const next = nextRunFromSchedule("5m", now);
    expect(next).toBe(now.getTime() + 300_000);
  });

  test("handles cron expressions", () => {
    const now = new Date("2026-01-15T08:00:00Z");
    const next = nextRunFromSchedule("0 9 * * *", now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now.getTime());
  });

  test("returns null for invalid schedules", () => {
    expect(nextRunFromSchedule("invalid")).toBeNull();
  });
});

describe("job delivery visibility", () => {
  const hasUndelivered = (job: { delivered: number; result: string | null; error: string | null }) =>
    job.delivered === 0 && (job.result !== null || job.error !== null);

  test("cron job with pending status and undelivered result is still deliverable", () => {
    expect(hasUndelivered({ delivered: 0, result: "ok", error: null })).toBe(true);
  });

  test("cron job with pending status and undelivered error is still deliverable", () => {
    expect(hasUndelivered({ delivered: 0, result: null, error: "boom" })).toBe(true);
  });

  test("delivered jobs are excluded even if they keep latest output", () => {
    expect(hasUndelivered({ delivered: 1, result: "ok", error: null })).toBe(false);
  });

  test("jobs without result or error are excluded", () => {
    expect(hasUndelivered({ delivered: 0, result: null, error: null })).toBe(false);
  });
});

describe("undelivered job summary ok flag", () => {
  // Mirrors the mapping in getUndeliveredJobSummaries: a job is "ok" when it
  // produced a result; a job that only has an error is a failure.
  const okFlag = (job: { result: string | null }) => job.result != null;

  test("result present means success", () => {
    expect(okFlag({ result: "done" })).toBe(true);
  });

  test("no result (error path) means failure", () => {
    expect(okFlag({ result: null })).toBe(false);
  });
});

describe("durable App Intent jobs", () => {
  test("schema migration is additive and creates intent columns", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        schedule TEXT,
        prompt TEXT NOT NULL,
        execution_type TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        next_run_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);

    ensureJobsSchema(db);
    const columns = db.query("PRAGMA table_info(jobs)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    expect(names.has("request_id")).toBe(true);
    expect(names.has("session_id")).toBe(true);
    expect(names.has("origin")).toBe(true);
    expect(names.has("silent")).toBe(true);
    db.close();
  });

  test("same request id returns one durable job", () => {
    const db = new Database(":memory:");
    const options = {
      requestId: "1feab5d0-52f7-4c34-9b07-b8e0ca92a080",
      sessionId: "session-1",
      prompt: "Turn on the office lights",
    };

    const first = createIntentJob(options, db);
    const duplicate = createIntentJob(options, db);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    db.close();
  });

  test("reusing a request id for different content is rejected", () => {
    const db = new Database(":memory:");
    const requestId = "1feab5d0-52f7-4c34-9b07-b8e0ca92a080";
    createIntentJob({ requestId, sessionId: "session-1", prompt: "First" }, db);

    expect(() => createIntentJob({ requestId, sessionId: "session-1", prompt: "Second" }, db))
      .toThrow(IntentJobConflictError);
    db.close();
  });

  test("an interrupted intent is not automatically executed twice", () => {
    const db = new Database(":memory:");
    const created = createIntentJob({
      requestId: "1feab5d0-52f7-4c34-9b07-b8e0ca92a080",
      sessionId: "session-1",
      prompt: "Create a reminder",
    }, db).job;
    db.run("UPDATE jobs SET status = 'running' WHERE id = ?", [created.id]);

    initJobs(db);
    const recovered = db.query("SELECT status, enabled, error FROM jobs WHERE id = ?").get(created.id) as {
      status: string;
      enabled: number;
      error: string;
    };

    expect(recovered.status).toBe("failed");
    expect(recovered.enabled).toBe(0);
    expect(recovered.error).toContain("outcome unknown");
    db.close();
  });

  test("status lookup returns only requested intent jobs", () => {
    const db = new Database(":memory:");
    const first = createIntentJob({ requestId: "request-1", sessionId: "session-1", prompt: "First" }, db).job;
    createIntentJob({ requestId: "request-2", sessionId: "session-1", prompt: "Second" }, db);
    db.run("UPDATE jobs SET status = 'completed', delivered = 1 WHERE id = ?", [first.id]);

    expect(getIntentJobStatuses(["request-1", "missing"], db)).toEqual([{
      requestId: "request-1",
      status: "completed",
      delivered: true,
    }]);
    db.close();
  });
});
