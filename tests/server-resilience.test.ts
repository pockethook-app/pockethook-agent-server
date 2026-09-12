import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureJobsSchema } from "../src/jobs.js";

// Run the real HTTP handler and scheduler with a disposable database and a
// deliberately stalled local provider. Never start jobs from the user's data.
test("duplicate result pickup bypasses AI; a stalled AI job releases the queue without retrying", async () => {
  const root = join(import.meta.dir, "..");
  const dir = mkdtempSync(join(tmpdir(), "pockethook-resilience-"));
  let providerCalls = 0;
  let streamCancelled = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    providerCalls++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"stalled"}}\n\n'));
      },
      cancel() { streamCancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let db: Database | undefined;
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    mkdirSync(join(dir, "data"));
    mkdirSync(join(dir, "workspace"));
    db = new Database(join(dir, "data/memory.db"));
    ensureJobsSchema(db);
    db.run(`INSERT INTO jobs (name,type,prompt,execution_type,status,result,created_at,completed_at,next_run_at,enabled)
      VALUES ('ready','once','','shell','completed','[{"msg":"ready result"}]',0,0,0,0)`);
    db.run(`INSERT INTO jobs (name,type,prompt,execution_type,status,created_at,next_run_at,timeout_ms)
      VALUES ('stalled','once','Reply hello','prompt','pending',0,0,1500)`);
    db.run(`INSERT INTO jobs (name,type,prompt,execution_type,status,created_at,next_run_at)
      VALUES ('next','once','printf after-timeout','shell','pending',0,1)`);
    writeFileSync(join(dir, "start.ts"), `import './src/index.ts'; import { triggerScheduler } from './src/jobs.ts'; triggerScheduler();`);
    child = Bun.spawn([process.execPath, "run", "start.ts"], {
      cwd: dir,
      env: { PATH: process.env.PATH!, PORT: String(port), AUTH_TOKEN: "test-token",
        LLM_API_KEY: "test-key", LLM_PROVIDER: "openai", LLM_MODEL: "gpt-6-astra",
        LLM_BASE_URL: `${provider.url.origin}/v1`, VECTOR_MEMORY: "false", LOCALE_COUNTRY: "Spain",
        TOOLS: "shell", LOG_LEVEL: "error" },
      stdout: "ignore", stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    async function until(check: () => boolean | Promise<boolean>) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for disposable server");
    }
    await until(async () => {
      try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) })).ok && providerCalls > 0; }
      catch { return false; }
    });
    const collect = async () => {
      const response = await fetch(base, { method: "POST", headers: {
        "Content-Type": "application/json", Authorization: "Bearer test-token",
      }, body: JSON.stringify([{ sessionId: "c2d1da50-2ae0-481c-846b-951fbcf47ab5", action: "sendMessage", chatInput: "fetchPendingTasks" }]),
      signal: AbortSignal.timeout(500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const results = await Promise.all([collect(), collect()]);
    expect(results.flat().map((item: any) => item.msg).sort()).toEqual(["false", "ready result"]);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/jobs`)).status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='messages'").get()).toBeNull();
    await until(() => (db!.query("SELECT status FROM jobs WHERE name='next'").get() as any)?.status === "completed");
    const stalled = db.query("SELECT status,error,retries FROM jobs WHERE name='stalled'").get() as any;
    expect(stalled.status).toBe("failed");
    expect(stalled.error).toContain("timed out");
    expect(stalled.retries).toBe(0);
    expect((db.query("SELECT result FROM jobs WHERE name='next'").get() as any).result).toBe("after-timeout");
    await until(() => streamCancelled);
    expect(providerCalls).toBe(1);
  } finally {
    if (child) { child.kill(); await child.exited; }
    db?.close();
    provider.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
