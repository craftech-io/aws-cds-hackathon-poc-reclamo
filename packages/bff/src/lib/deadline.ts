// Deadline for calls that have no SDK-level timeout of their own (an injected port, a polling
// loop). AWS clients get theirs from lib/clients.ts; this covers the rest so nothing in a Lambda
// waits longer than the Lambda itself.
export class DeadlineError extends Error {
  override readonly name = "DeadlineError";
  readonly retryable = true;
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} exceeded ${timeoutMs} ms`);
  }
}

export async function withDeadline<T>(operation: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError(`timeoutMs must be positive, got ${timeoutMs}`);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineError(operation, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
