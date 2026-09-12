import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelProcessOnAbort } from "../src/subprocess.js";

test.skipIf(process.platform === "win32")("cancellation stops the command's descendants before they can write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pockethook-cancel-"));
  const marker = join(dir, "late-write");
  const controller = new AbortController();
  const child = spawn("bash", ["-c", 'sh -c \'sleep 0.3; touch "$TASK_MARKER"\' & echo ready; wait'], {
    detached: true, env: { PATH: process.env.PATH!, TASK_MARKER: marker }, stdio: ["ignore", "pipe", "pipe"],
  });
  cancelProcessOnAbort(child, controller.signal);
  try {
    const closed = new Promise((resolve) => child.once("close", resolve));
    await new Promise((resolve, reject) => { child.stdout!.once("data", resolve); child.once("error", reject); });
    controller.abort();
    await closed;
    await Bun.sleep(400);
    expect(existsSync(marker)).toBe(false);
  } finally {
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  }
});
