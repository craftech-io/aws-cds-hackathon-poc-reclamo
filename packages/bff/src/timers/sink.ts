// The `TimerEventSink` over the one producer of the customer queues (worker/enqueue.ts): every event a
// timer produces is enqueued with the in-process `SCHEDULER` caller of the timer's own world, so the
// producer's cross-world fence holds for timers too.
import type { Enqueuer } from "../worker/enqueue";
import type { TimerEventSink } from "./events";

export function enqueuerSink(enqueuer: Pick<Enqueuer, "enqueueCustomerEvent">): TimerEventSink {
  return {
    async enqueue(event) {
      await enqueuer.enqueueCustomerEvent(event, { kind: "SCHEDULER", worldId: event.worldId, eventId: event.eventId });
    },
  };
}
