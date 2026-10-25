// Exponential backoff with full jitter for every external call (CLAUDE.md: "toda llamada externa
// con timeout y reintento con backoff"). The predicate decides what is worth retrying; by default
// only errors flagged `retryable` by the typed error classes of @reclamo/shared.
import { isRetryable } from "@reclamo/shared";

export interface RetryOptions {
  /** Total attempts including the first one. */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to Math.random. */
  readonly random?: () => number;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1_000,
} as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full jitter: a random delay in [0, min(max, base * 2^attempt)], which spreads retries of many
// concurrent Lambdas instead of lining them up (AWS Architecture Blog, "Exponential Backoff And
// Jitter").
export function backoffDelayMs(attempt: number, options: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "random"> = {}): number {
  const base = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const max = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  const shouldRetry = options.shouldRetry ?? ((error) => isRetryable(error));
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      if (isLast || !shouldRetry(error, attempt)) throw error;
      await sleep(backoffDelayMs(attempt, options));
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastError;
}
