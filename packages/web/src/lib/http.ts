// fetch with the timeout and retry every external call must carry (CLAUDE.md). Retries are
// limited to failures where nothing reached the server or the server said it did nothing
// (network errors and 502/503/504 on GET), so a mutation is never applied twice.

export interface FetchRetryOptions {
  /** Total attempts, including the first one. */
  readonly attempts?: number;
  /** Per-attempt timeout. */
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
}

const DEFAULTS: Required<FetchRetryOptions> = { attempts: 3, timeoutMs: 15_000, baseDelayMs: 300 };
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  return exponential + Math.random() * baseDelayMs;
}

function isGet(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase() === "GET";
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return { ...init, signal };
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const { attempts, timeoutMs, baseDelayMs } = { ...DEFAULTS, ...options };
  const retryOnStatus = isGet(input, init);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (init?.signal?.aborted) throw init.signal.reason;
    try {
      const response = await fetch(input, withTimeout(init, timeoutMs));
      if (!retryOnStatus || !RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      // A caller-initiated abort is final; a timeout or a network failure is worth a retry.
      if (init?.signal?.aborted) throw error;
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await sleep(backoff(attempt, baseDelayMs));
  }
  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}
