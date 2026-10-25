// Lambda entry of `InboundWhatsApp` (infra/messaging-whatsapp.ts, `HANDLERS.InboundWhatsApp` of
// infra/workers-spec.ts): subscribed to the End User Messaging Social topic (live) and invoked by the
// phone simulator of the Bff and by the QaDriver with the same SNS shape and an HMAC-signed envelope
// (simulated). Everything is decided in order by the WhatsApp adapter (channels/whatsapp/inbound.ts:
// origin before anything, statuses, identity by the linked phone, real-hour limit, nonces, opt-out,
// media announced before it lands) and the intake (intake/accept.ts: classifier, number and
// acknowledgement, image binding, then the queue). This entry only builds the ports of the invocation
// (intake/stage.ts) and returns the summary: the simulator reads which message a tap became.
//
// A failure midway throws: SNS (live) retries the delivery and every write on the way is keyed by the
// `wamid`, so the redelivery completes what was interrupted and repeats nothing.
import type { Context } from "aws-lambda";
import { type InboundSummary, processWhatsAppEvent } from "../channels/whatsapp/inbound";
import type { WhatsAppInboundDeps } from "../channels/whatsapp/ports";
import { type Logger, correlationIdFrom, createLogger } from "../lib/log";
import { stageInboundDeps } from "../intake/stage";

export type InboundDepsFactory = (log: Logger, coldStart: boolean) => WhatsAppInboundDeps;

export interface InboundHandlerOptions {
  readonly deps: InboundDepsFactory;
  readonly logger?: (correlationId: string) => Logger;
}

/** The entry over a deps factory; the first event of the container is the cold start (`ackLatencyMs`). */
export function createInboundWhatsAppHandler(options: InboundHandlerOptions) {
  let warm = false;
  return async (event: unknown, context?: Pick<Context, "awsRequestId">): Promise<InboundSummary> => {
    const coldStart = !warm;
    warm = true;
    const correlationId = correlationIdFrom(context?.awsRequestId);
    const log = (options.logger ?? ((id: string) => createLogger({ correlationId: id, bindings: { fn: "InboundWhatsApp" } })))(correlationId);
    const summary = await processWhatsAppEvent(event, options.deps(log, coldStart));
    const messages = summary.records.flatMap((record) => record.messages);
    log.info("inbound_whatsapp.done", { recordCount: summary.records.length, messageCount: messages.length, outcomes: messages.map((message) => message.outcome), coldStart });
    return summary;
  };
}

export const handler = createInboundWhatsAppHandler({ deps: stageInboundDeps });
