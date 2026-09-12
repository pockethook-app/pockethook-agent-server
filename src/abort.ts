/** Bound a run even when an upstream operation ignores cancellation. */
export class RunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms; partial work may have completed. Automatic retry disabled.`);
    this.name = "RunTimeoutError";
  }
}

export function withAbort<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason);
      onAbort?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RunTimeoutError(timeoutMs)), timeoutMs);
  try {
    return await withAbort(() => operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
