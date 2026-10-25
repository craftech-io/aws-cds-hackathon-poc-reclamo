// Waits of the scenario runner (docs/test-plan.md §4.3 "Esperas"): every wait polls a non-blocking probe
// of the `QaDriver` (each invocation answers within 30-60 s) until it holds or its cap runs out. After
// the first full run each cap is set to p99 × 1.5 from `scenario-report.json` (the step durations).

export const WAITS = {
  /** The number on the spot: a hard cap per message (the p95 goal of 5 s is computed over the suite). */
  ackSec: 10,
  /** One turn of the agent, plus the obligation turn the code may enqueue after it. */
  turnSec: 180,
  /** `read_receipt` after the scan of the image closed. */
  readerSec: 30,
  /** An event of the SES mailbox simulator back through the configuration set. */
  sesEventSec: 120,
  /** A real schedule of EventBridge Scheduler firing a timer 120 s ahead. */
  schedulerSec: 240,
  /** The world quiet, in total. */
  settleSec: 300,
  /** Memory extraction until the sentinel record appears (probes of 60 s). */
  memoryExtractionSec: 600,
  memoryPurgeSec: 120,
  /** A world of the `guest` template created, or reset (`RESETTING → READY`), polled every 10 s. */
  worldSec: 600,
  worldEverySec: 10,
  /** The malware protection plan of `Media` until `ACTIVE`, polled every 30 s. */
  malwarePlanSec: 600,
  malwarePlanEverySec: 30,
  /** The QA dead-letter queue (FL-108). */
  dlqSec: 600,
} as const;

/** Two `settled` answers this far apart make a world quiet (docs/test-plan.md §4.3 "Quiescencia"). */
export const QUIET_GAP_SEC = 10;

export interface EventuallyOptions {
  readonly timeoutSec: number;
  readonly everySec?: number;
  /** Real time, injected by the tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class WaitTimeout extends Error {
  override readonly name = "WaitTimeout";
  constructor(
    readonly what: string,
    readonly timeoutSec: number,
    readonly last: string | undefined,
  ) {
    super(`${what}: not reached within ${timeoutSec} s${last === undefined ? "" : ` (last: ${last})`}`);
  }
}

export const realSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `probe` until it returns something other than `undefined` or `false`. A probe that throws is
 * retried until the deadline, and its last error is reported with the timeout.
 */
export async function eventually<T>(what: string, probe: () => Promise<T | undefined | false>, options: EventuallyOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const deadline = now() + options.timeoutSec * 1_000;
  const every = (options.everySec ?? 5) * 1_000;
  let last: string | undefined;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
      last = undefined;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const left = deadline - now();
    if (left <= 0) throw new WaitTimeout(what, options.timeoutSec, last);
    await sleep(Math.min(every, left));
  }
}
