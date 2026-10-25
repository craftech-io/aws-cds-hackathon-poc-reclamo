// Lambda entry of `EventWorker`, `SignupEventWorker` and `QaEventWorker` (infra/workers.ts, `HANDLERS` of
// infra/workers-spec.ts): the same code on three queues, batch 1 (docs/architecture.md §7). The worker of
// packages/bff/src/worker/ runs with the stage dependencies (worker/production.ts), built on the first
// event of the container, so importing this module reads nothing. An event that fails is thrown back to
// SQS; on its last delivery the worker takes it out of `inFlight` first (FL-108).
import type { LambdaContextLike, SqsRecordLike } from "../worker/worker";
import { type EventWorker, createEventWorker } from "../worker/worker";
import { productionWorkerDeps } from "../worker/production";

let worker: EventWorker | undefined;

export async function handler(event: { readonly Records: readonly SqsRecordLike[] }, context?: LambdaContextLike): Promise<void> {
  worker ??= createEventWorker(productionWorkerDeps());
  await worker(event, context);
}
