import { expect, test } from "bun:test";
import { RunTimeoutError, withAbort, withTimeout } from "../src/abort.js";

test("a non-cooperative operation cannot hold the deadline open", async () => {
  let signal: AbortSignal | undefined;
  await expect(withTimeout(async (s) => { signal = s; return new Promise(() => {}); }, 20)).rejects.toBeInstanceOf(RunTimeoutError);
  expect(signal!.aborted).toBe(true);
});

test("a completed run does not get cancelled later", async () => {
  let signal: AbortSignal | undefined;
  expect(await withTimeout(async (s) => { signal = s; return "done"; }, 10)).toBe("done");
  await Bun.sleep(20);
  expect(signal!.aborted).toBe(false);
});

test("late work cannot start after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = withAbort(async () => { calls++; }, controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
  expect(() => withAbort(async () => { calls++; }, controller.signal)).toThrow("cancelled");
  expect(calls).toBe(0);
});
