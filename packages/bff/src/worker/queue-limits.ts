// Life of a customer event in its FIFO queue (docs/architecture.md §7), with no imports: the worker,
// the busy check (clock/busy.ts) and infra/workers-spec.ts read the same numbers.

/** `maxReceiveCount` of the three customer queues (infra/workers-spec.ts reads it): the second delivery is the last. */
export const MAX_RECEIVE_COUNT = 2;
/** Timeout of the three event workers (infra/workers-spec.ts reads it). */
export const WORKER_TIMEOUT_SECONDS = 360;
/** Six times the worker's timeout, as AWS recommends for an SQS event source mapping: a failed delivery comes back after this. */
export const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 6 * WORKER_TIMEOUT_SECONDS;
/**
 * A bound on the real life of a customer event in its queue (about 78 minutes): each of its deliveries
 * may wait out a visibility timeout (a failed delivery, or the failed head of its FIFO group that holds
 * it back) and its last one runs at most the worker's timeout. An `inFlight` token younger than this may
 * still belong to a live message, a THROTTLED turn waiting for its redelivery included, so quiescence
 * keeps waiting for it (clock/busy.ts); only an older one is reported stale.
 */
export const EVENT_MAX_LIFE_MS = (MAX_RECEIVE_COUNT * QUEUE_VISIBILITY_TIMEOUT_SECONDS + WORKER_TIMEOUT_SECONDS) * 1000;
