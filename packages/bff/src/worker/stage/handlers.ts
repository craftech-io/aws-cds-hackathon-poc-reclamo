// The deterministic handlers of the other modules as the event workers run them in the stage
// (worker/ports.ts `EventHandlers`), imported in process with the worker's role:
//
//   TIMER             timers/effects.ts `runTimerEvent`; a `FOLLOW_UP` answers `TURN` → worker/follow-up.ts
//   reconcile         reconcile/service.ts on the complaint's reading (stage/reconcile.ts)
//   OPERATOR_ANSWER   complaints/answer.ts with the operator as actor and sender (stage/answer.ts)
//   money             the plan of the `actions` target, executed once with the approval's key (stage/money.ts)
//   EMAIL_EVENT       the effects of `record_email_event` (stage/email.ts)
//   confirmAction     the closure and data change confirmation emails (stage/confirm.ts)
//   HEALTH_PROBE      `GET /v1/health` of the core and the networks, signed with the worker's role
//
// Every client is built on its first use, so a cold start reads no link it does not need.
import type { DocumentStore } from "../../agent-tools/complaints/ports";
import type { ComplaintsDeps } from "../../complaints/deps";
import type { Connector } from "../../connector/port";
import type { CoreClient } from "../../core/client";
import type { NetworkClient } from "../../networks/client";
import type { SettlementFileReader } from "../../networks/settlement-files";
import type { OutboundGate } from "../../outbound/types";
import { runTimerEvent } from "../../timers/effects";
import { queueFollowUp } from "../follow-up";
import type { EventHandlers } from "../ports";
import { stageWrittenAnswer } from "./answer";
import { stageConfirmation } from "./confirm";
import { stageEmailEffects } from "./email";
import { stageApprovedMoney } from "./money";
import { stageReconcile } from "./reconcile";

export interface StagePorts {
  readonly data: Connector;
  readonly gate: OutboundGate;
  readonly complaints: () => ComplaintsDeps;
  readonly core: () => CoreClient;
  readonly networks: () => NetworkClient;
  readonly settlementFiles: () => SettlementFileReader;
  readonly documents: () => DocumentStore;
}

export function stageEventHandlers(ports: StagePorts): EventHandlers {
  const emailEffects = stageEmailEffects(ports);
  return {
    async fireTimer(event, ctx) {
      const outcome = await runTimerEvent(event, { connector: ports.data, complaints: ports.complaints(), gate: ports.gate, log: ctx.log, realNow: ctx.now });
      ctx.log.info("timer.event_done", { status: outcome.status, ...("reason" in outcome ? { reason: outcome.reason } : { action: outcome.action }) });
      if (outcome.status === "TURN") await queueFollowUp(ports.data, ctx, event, outcome.complaintId);
    },
    reconcile: stageReconcile(ports),
    writtenAnswer: stageWrittenAnswer(ports),
    confirmAction: stageConfirmation(ports),
    money: stageApprovedMoney(ports),
    emailEffects: (event, ctx) => emailEffects(event, ctx),
    async healthProbe(event, ctx) {
      const [core, networks] = await Promise.all([ports.core().health(event.correlationId ?? event.eventId), ports.networks().health()]);
      ctx.log.info("health_probe.done", { core: core.status, networks: networks.status });
      return { core: core.status, networks: networks.status };
    },
  };
}
