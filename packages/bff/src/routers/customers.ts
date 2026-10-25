// `customers` router (docs/tool-catalog.md "Procedimientos de la consola", docs/design-brief.md §9:
// "Cliente"; FL-064, FL-102). The customer's file reads the lender core (masked, read only); the
// composer ENQUEUES what a person wants to send and the gate decides in the worker, so an attempt the
// policy forbids (the "Recordatorio de mora" by WhatsApp) still lands on the tape, in red, with its
// permitted paths.
//
//   get                  the core's account, wallet, loans with their instalments and the last
//                        operations, plus this world's complaints of the customer, the conversation's
//                        control and where the identity challenge stands (24 real hours)
//   compose (W)          `OPERATOR_SEND` with the message type and the channel the person chose
//   unlockChallenge (W)  lifts a locked identity challenge (two failures in 24 real hours), audited
//                        `CHALLENGE_UNLOCKED` before the ledger is cleared
import { z } from "zod";
import { Channel, CustomerId, Id, MessageKind, addCalendarDays } from "@reclamo/shared";
import { standingOf } from "../agent-tools/identity/challenge";
import { KIND_ROUTES } from "../channel-policy/kinds";
import { deadlineText } from "../complaints/sla";
import { INBOX_CLOSED_STATUSES } from "../domain/complaint";
import { localDateAr } from "../services/business-days";
import { pesosFromCents } from "../services/money";
import { OutboundTemplate, enqueueOperatorSend, oneBody } from "./conversation";
import { type OperationsServices, WorldScoped, auditOp, checkWorld, operationsOf, worldTime } from "./inbox";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

/** Days of operations the file shows (the core's widest window is 90). */
const OPERATIONS_WINDOW_DAYS = 60;

/**
 * What a person may pick in the composer: every kind an operator may send (channel-policy/kinds.ts),
 * except the written answer (`complaints.answer`) and the formal debt notice (only a reroute, rendered
 * by code). The channel is the person's choice: the policy decides whether that kind goes by it.
 */
export const COMPOSE_KINDS: readonly MessageKind[] = MessageKind.options.filter(
  (kind) => KIND_ROUTES[kind].senders.includes("OPERATOR") && kind !== "FORMAL_ANSWER" && kind !== "COLLECTION_NOTICE_EMAIL",
);

const CustomerRef = z.object({ ...WorldScoped, customerId: CustomerId }).strict();

const ComposeInput = CustomerRef.extend({
  kind: MessageKind.refine((kind) => COMPOSE_KINDS.includes(kind), "this kind is not sent from the composer"),
  channel: Channel,
  text: z.string().trim().min(1).max(4_000).optional(),
  template: OutboundTemplate.optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  complaintId: Id.optional(),
})
  .strict()
  .refine(oneBody, { message: "text or template, exactly one", path: ["text"] });

async function fileOf(ctx: WorldContext, services: OperationsServices, customerId: string) {
  const worldId = ctx.principal.worldId;
  const { simNow, realNow } = await worldTime(ctx, services);
  const call = { worldId, simNow: simNow.toISOString(), correlationId: ctx.correlationId };
  const core = services.core();
  const today = localDateAr(simNow);
  const [customer, operations, complaints, conversation, ledger] = await Promise.all([
    core.call("getCustomer", call, { params: { customerId } }),
    core.call("listOperations", call, { params: { customerId }, query: { from: addCalendarDays(today, -OPERATIONS_WINDOW_DAYS), to: today } }),
    services.data.complaints.listByCustomer(worldId, customerId),
    services.data.conversations.getMeta(worldId, customerId),
    services.data.caps.getChallenge(worldId, customerId),
  ]);
  const loans = await Promise.all(
    customer.loans.map(async (loan) => ({
      ...loan,
      outstandingMoney: pesosFromCents(loan.outstanding),
      instalments: (await core.call("listInstalments", call, { params: { loanId: loan.loanId } })).instalments,
    })),
  );
  const challenge = standingOf(ledger, realNow);
  return {
    customer: { ...customer, wallet: { ...customer.wallet, balanceMoney: pesosFromCents(customer.wallet.balance) }, loans },
    operations: operations.operations,
    operationsTruncated: operations.truncated,
    complaints: complaints.map((complaint) => ({
      complaintId: complaint.complaintId,
      complaintNumber: complaint.complaintNumber,
      type: complaint.type,
      status: complaint.status,
      open: !INBOX_CLOSED_STATUSES.has(complaint.status),
      deadlineSim: complaint.deadlineSim,
      deadlineText: deadlineText(complaint.deadlineSim),
    })),
    conversation: conversation === undefined ? null : { control: conversation.control, controlledBy: conversation.controlledBy ?? null, windowOpenUntilSim: conversation.windowOpenUntilSim ?? null },
    challenge: { locked: challenge.locked, failures: challenge.failures, attemptsLeft: challenge.attemptsLeft },
    composeKinds: COMPOSE_KINDS,
    simNow: simNow.toISOString(),
  };
}

async function unlock(ctx: WorldContext, services: OperationsServices, customerId: string) {
  const worldId = ctx.principal.worldId;
  const { simNow, realNow } = await worldTime(ctx, services);
  const ledger = await services.data.caps.getChallenge(worldId, customerId);
  if (ledger === undefined) return { cleared: false, wasLocked: false };
  const standing = standingOf(ledger, realNow);
  // The audit row first: a person lifting an identity lock is never invisible, even if the clear fails.
  await services.data.write(
    auditOp(ctx, services, { action: "CHALLENGE_UNLOCKED", outcome: standing.locked ? "LOCKED" : "COUNTED", ruleIds: ["IDENTITY"], atSim: simNow, refs: { customerId, failures: String(standing.failures) } }),
  );
  await services.data.caps.clearChallenge(worldId, customerId);
  return { cleared: true, wasLocked: standing.locked };
}

export const customersRouter = router({
  get: accessProcedure("customers.get")
    .input(CustomerRef)
    .query(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      return fileOf(ctx, operationsOf(ctx.deps), input.customerId);
    }),

  compose: accessProcedure("customers.compose")
    .input(ComposeInput)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      return enqueueOperatorSend(ctx, operationsOf(ctx.deps), input);
    }),

  unlockChallenge: accessProcedure("customers.unlockChallenge")
    .input(CustomerRef)
    .mutation(async ({ ctx, input, path }) => {
      await checkWorld(ctx, path, input);
      return unlock(ctx, operationsOf(ctx.deps), input.customerId);
    }),
});
