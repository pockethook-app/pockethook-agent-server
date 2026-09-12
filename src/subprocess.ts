import type { ChildProcess } from "node:child_process";

/** Commands with a cancellation signal must be spawned in their own group. */
export function cancelProcessOnAbort(child: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return;
  const abort = () => {
    if (!child.pid) return;
    try {
      // Killing bash alone leaves its command running (and possibly writing).
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* The process may have exited between cancellation and kill. */ }
  };
  signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
}
