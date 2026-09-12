import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureJobsSchema, createIntentJob } from "../src/jobs.js";

test("HTTP result replay, explicit acknowledgement, protected uploads and durable shares", async () => {
  const root = join(import.meta.dir, "..");
  const dir = mkdtempSync(join(tmpdir(), "pockethook-protocol-"));
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture unavailable", { status: 503 }) });
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
    const sessionId = "535f0b9b-565c-47e5-9d61-cf41850c7a4b";
    const { job } = createIntentJob({ requestId: "fixture-intent", sessionId, prompt: "fixture" }, db);
    db.run("UPDATE jobs SET status='completed',enabled=0,completed_at=1,result=? WHERE id=?",
      [JSON.stringify([{ msg: "fixture reply", url: "pockethook://photos?latest=1" }]), job.id]);
    child = Bun.spawn([process.execPath, "run", "src/index.ts"], { cwd: dir,
      env: { PATH: process.env.PATH!, PORT: String(port), AUTH_TOKEN: "fixture-token",
        LLM_API_KEY: "fixture-key", LLM_PROVIDER: "openai", LLM_MODEL: "gpt-6-astra",
        LLM_BASE_URL: `${provider.url.origin}/v1`, VECTOR_MEMORY: "false", LOCALE_COUNTRY: "Spain",
        TOOLS: "", LOG_LEVEL: "error" }, stdout: "ignore", stderr: "pipe" });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    while (true) {
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(100) })).ok) break; }
      catch { /* Wait for this disposable process only. */ }
      if (Date.now() > deadline) throw new Error("Fixture server did not start");
      await Bun.sleep(20);
    }
    const headers = { Authorization: "Bearer fixture-token", "Content-Type": "application/json" };
    const body = (chatInput: string) => JSON.stringify([{ sessionId, action: "sendMessage", chatInput }]);
    const collect = async () => {
      const response = await fetch(base, { method: "POST", headers: { ...headers, "x-pockethook-result-acks": "1" }, body: body("fetchPendingTasks") });
      expect(response.status).toBe(200);
      return response.json() as Promise<any[]>;
    };
    const first = await collect();
    expect(first[0].url).toBe("pockethook://photos?latest=1");
    expect(await collect()).toEqual(first);
    expect((await fetch(`${base}/health`)).headers.get("X-PocketHook-Capabilities")).toContain("result-acks-v1");
    const receiptBody = JSON.stringify({ ids: [first[0].deliveryId] });
    expect((await fetch(`${base}/deliveries/ack`, { method: "POST", body: receiptBody })).status).toBe(401);
    expect((await fetch(`${base}/deliveries/ack`, { method: "POST", headers, body: receiptBody })).status).toBe(200);
    expect((await collect())[0].msg).toBe("false");

    const upload = await fetch(`${base}/uploads`, { method: "POST",
      headers: { Authorization: "Bearer fixture-token", "Content-Type": "text/plain" }, body: "fixture text" });
    expect(upload.status).toBe(201);
    const metadata = await upload.json() as { path: string };
    expect((await fetch(base + metadata.path)).status).toBe(401);
    const download = await fetch(base + metadata.path, { headers });
    expect(await download.text()).toBe("fixture text");
    expect(download.headers.get("Cache-Control")).toContain("no-store");

    const share = () => fetch(base, { method: "POST", headers: { ...headers,
      "x-pockethook-share": "1", "x-pockethook-request-id": "fixture-share" }, body: body("shared fixture") });
    const accepted = await share();
    expect(accepted.status).toBe(202);
    const ack = await accepted.json() as { jobId: number };
    expect((db.query("SELECT origin FROM jobs WHERE id=?").get(ack.jobId) as any).origin).toBe("share");
    expect((await (await share()).json() as any).jobId).toBe(ack.jobId);
    expect((db.query("SELECT COUNT(*) AS count FROM jobs WHERE request_id='fixture-share'").get() as any).count).toBe(1);
  } finally {
    if (child) { child.kill(); await child.exited; }
    db?.close();
    provider.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
