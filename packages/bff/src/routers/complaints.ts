// `complaints` router (docs/tool-catalog.md "Procedimientos de la consola", docs/design-brief.md §9;
// FL-089). Every id is read under the principal's world; an input that names another world is refused
// with 403 `CROSS_WORLD` before anything is read.
//
//   get          the case: the complaint, its evidence (image locations stripped), actions, approvals,
//                notes, the conversation's control and where it stands against its deadline
//   timeline     one list in simulated time: messages, emails with their delivery proof, tape decisions,
//                tool calls and console actions from `AuditLog` (codes and ids only), register entries,
//                milestones, status changes and notes; plus what is still pending, with its reason
//   evidenceUrl  a receipt image of the case for `fetch()` → `blob:`: a 5-minute GET of `Media`, or a seed
//                receipt inline after its hash was checked (`Seed` is not a host the console may reach)
//   answer (W R) the operator's written answer: checked here, ENQUEUED as `OPERATOR_ANSWER` (PDF + SES
//                run in the worker through the gate)
//   escalate (W) `HUMAN_REVIEW` with the reason, through the state machine and its register entry
//   note (W)     an internal note, masked before it is stored
import { z } from "zod";
import { ComplaintOutcome, HandoffReason, Id, ToolError, businessDaysBetween } from "@reclamo/shared";
import { AnswerAttachment, checkAnswerPreconditions } from "../complaints/answer";
import { complaintOwnerKey, deadlineText, loadHolidays } from "../complaints/sla";
import { canTransition, transition } from "../complaints/state-machine";
import type { Evidence } from "../domain/case-items";
import type { Complaint } from "../domain/complaint";
import { ofEpoch } from "../domain/ledger";
import { sha256Hex } from "../lib/crypto";
import { maskSensitive } from "../lib/mask";
import { MAX_IMAGE_BYTES, ReceiptImageDetails } from "../receipts/schema";
import { isSeedReceiptHash } from "../receipts/seed-hash";
import { pesosFromCents } from "../services/money";
import { localDateAr } from "../services/business-days";
import {
  EVIDENCE_URL_SECONDS,
  type OperationsServices,
  WorldScoped,
  actorOfCtx,
  auditOp,
  blockedByOf,
  checkWorld,
  complaintOf,
  enqueueAs,
  operationsOf,
  worldTime,
} from "./inbox";
import { accessProcedure } from "./roles";
import { orderTimeline, pairStatusChanges } from "./timeline-order";
import { type WorldContext, router } from "./trpc";

const ComplaintRef = z.object({ ...WorldScoped, complaintId: Id }).strict();

/** Where an image lives is the server's business: the console asks `evidenceUrl` for it. */
const HIDDEN_DETAILS: ReadonlySet<string> = new Set(["s3Key", "seedKey", "announceKey"]);

function evidenceView(evidence: Evidence) {
  const details = Object.fromEntries(Object.entries(evidence.details).filter(([key]) => !HIDDEN_DETAILS.has(key)));
  return { evidenceId: evidence.evidenceId, kind: evidence.kind, refId: evidence.refId ?? null, atSim: evidence.atSim, actor: evidence.actor, details };
}

async function referenced(ctx: WorldContext, path: string, input: z.infer<typeof ComplaintRef>) {
  await checkWorld(ctx, path, input);
  const services = operationsOf(ctx.deps);
  return { services, complaint: await complaintOf(ctx, services, input.complaintId) };
}

async function caseView(ctx: WorldContext, services: OperationsServices, complaint: Complaint) {
  const worldId = ctx.principal.worldId;
  const [file, conversation, holidays, { simNow }] = await Promise.all([
    services.data.caseItems.caseFile(worldId, complaint.complaintId),
    services.data.conversations.getMeta(worldId, complaint.customerId),
    loadHolidays(services.data),
    worldTime(ctx, services),
  ]);
  return {
    complaint: {
      complaintId: complaint.complaintId,
      complaintNumber: complaint.complaintNumber,
      customerId: complaint.customerId,
      kind: complaint.kind,
      type: complaint.type,
      status: complaint.status,
      outcome: complaint.outcome ?? null,
      priority: complaint.priority,
      origin: complaint.origin,
      control: complaint.control,
      channel: complaint.channel,
      summary: complaint.summary,
      subject: complaint.subject ?? null,
      filedAtSim: complaint.filedAtSim,
      deadlineSim: complaint.deadlineSim,
      deadlineText: deadlineText(complaint.deadlineSim),
      businessDaysLeft: businessDaysBetween(localDateAr(simNow), localDateAr(new Date(complaint.deadlineSim)), holidays),
      slaState: complaint.slaState,
      blockedBy: blockedByOf(complaint),
      emailAnswerConsent: complaint.emailAnswerConsent,
      answer: complaint.answer ?? null,
      handoff: complaint.handoff ?? null,
      version: complaint.version,
    },
    conversation: conversation === undefined ? null : { control: conversation.control, controlledBy: conversation.controlledBy ?? null },
    evidence: file.evidence.map(evidenceView),
    actions: file.actions.map((action) => ({ ...action, amount: action.amountCents === undefined ? null : pesosFromCents(action.amountCents) })),
    approvals: file.approvals.map((approval) => ({ ...approval, amount: pesosFromCents(approval.amountCents) })),
    executions: file.executions,
    notes: file.notes,
    simNow: simNow.toISOString(),
  };
}

/** The window before filing in which messages without a complaint still belong to its story. */
const LEAD_IN_MS = 24 * 60 * 60 * 1000;

async function timelineOf(ctx: WorldContext, services: OperationsServices, complaint: Complaint) {
  const worldId = ctx.principal.worldId;
  const { complaintId, customerId } = complaint;
  const since = new Date(Date.parse(complaint.filedAtSim) - LEAD_IN_MS);
  const mine = (item: { complaintId?: string | undefined; atSim: string }) => item.complaintId === complaintId || (item.complaintId === undefined && Date.parse(item.atSim) >= since.getTime());
  const [messages, sent, tape, audit, timers, register, notes, pending] = await Promise.all([
    services.data.conversations.listMessages(worldId, customerId),
    services.data.conversations.listSentSince(worldId, customerId, since.toISOString()),
    services.data.chains.listTapeByComplaint(worldId, complaintId),
    services.data.audit.listByRef(worldId, `CMP#${complaintId}`, 200),
    services.data.timers.listByOwner(worldId, complaintOwnerKey(complaintId)),
    services.data.chains.listRegisterByComplaint(worldId, complaint.epoch, complaint.complaintNumber),
    services.data.caseItems.listNotes(worldId, complaintId),
    services.data.runtime.listPending(worldId),
  ]);
  const registerId = (seq: number) => `reg-${String(seq).padStart(8, "0")}`;
  const recordedBy = pairStatusChanges(complaint.statusHistory, register.map((entry) => ({ id: registerId(entry.seq), seq: entry.seq, status: entry.status, atSim: entry.atSim })));
  const items = orderTimeline([
    ...messages.filter(mine).map((message) => ({
      type: "MESSAGE",
      atSim: message.atSim,
      direction: message.direction,
      real: message.createdAt,
      messageId: message.messageId,
      id: message.messageId,
      item: {
        type: "MESSAGE" as const,
        atSim: message.atSim,
        messageId: message.messageId,
        direction: message.direction,
        channel: message.channel,
        kind: message.kind ?? null,
        sender: message.sender ?? null,
        body: message.body,
        media: message.media ? { scan: message.media.scan ?? null } : null,
        templateName: message.templateName ?? null,
        status: message.status,
        disclosure: message.flags.disclosure === true,
        tapeRef: message.tapeRef ?? null,
      },
    })),
    ...sent.emails
      .filter((email) => email.complaintId === complaintId || email.complaintId === undefined)
      .map((email) => ({
        type: "EMAIL",
        atSim: email.sentAtSim,
        real: email.createdAt,
        id: email.mailId,
        item: {
          type: "EMAIL" as const,
          atSim: email.sentAtSim,
          mailId: email.mailId,
          kind: email.kind,
          subject: email.subject,
          toMasked: email.toMasked,
          deliveryProof: email.deliveryProof ?? null,
          events: email.events.map((event) => ({ type: event.type, atReal: event.atReal })),
          attachments: email.attachments.map((attachment) => ({ docKind: attachment.docKind, sha256: attachment.sha256 })),
          rawSha256: email.rawSha256 ?? null,
        },
      })),
    ...ofEpoch(tape, complaint.epoch).map((entry) => ({
      type: "TAPE",
      atSim: entry.atSim,
      real: entry.atReal,
      seq: entry.seq,
      messageId: entry.messageId ?? null,
      id: entry.tapeId,
      item: {
        type: "TAPE" as const,
        atSim: entry.atSim,
        tapeId: entry.tapeId,
        seq: entry.seq,
        decision: entry.decision,
        result: entry.result ?? null,
        ruleIds: entry.ruleIds,
        sender: entry.sender,
        channel: entry.channel,
        kind: entry.kind,
        messageId: entry.messageId ?? null,
        payloadHash: entry.payloadHash ?? null,
        reroute: entry.reroute ?? null,
        rerouteOf: entry.rerouteOf ?? null,
        nextAllowedAt: entry.nextAllowedAt ?? null,
      },
    })),
    // Tools and console actions: action, actor, outcome, rules and the ids of `refs` (masked when written).
    ...ofEpoch(audit, complaint.epoch).map((entry) => ({
      type: "ACTION",
      atSim: entry.atSim ?? entry.ts,
      real: entry.ts,
      id: entry.auditId,
      item: { type: "ACTION" as const, atSim: entry.atSim ?? entry.ts, action: entry.action, actor: entry.actor, outcome: entry.outcome ?? null, ruleIds: entry.ruleIds ?? [], refs: entry.refs },
    })),
    ...timers.map((timer) => ({
      type: "MILESTONE",
      atSim: timer.dueAtSim,
      id: timer.timerId,
      item: {
        type: "MILESTONE" as const,
        atSim: timer.dueAtSim,
        timerId: timer.timerId,
        kind: timer.kind,
        milestone: typeof timer.payload["milestone"] === "string" ? timer.payload["milestone"] : null,
        status: timer.status,
        firedAtSim: timer.firedAtSim ?? null,
        firedBy: timer.firedBy ?? null,
      },
    })),
    ...register.map((entry) => ({
      type: "REGISTER",
      atSim: entry.atSim,
      real: entry.atReal,
      seq: entry.seq,
      id: registerId(entry.seq),
      item: { type: "REGISTER" as const, atSim: entry.atSim, seq: entry.seq, eventType: entry.eventType, status: entry.status ?? null, reason: entry.reason ?? null, hash: entry.hash },
    })),
    ...complaint.statusHistory.map((change, index) => ({
      type: "STATUS",
      atSim: change.atSim,
      seq: index,
      follows: recordedBy[index],
      id: `status-${String(index).padStart(4, "0")}`,
      item: { type: "STATUS" as const, atSim: change.atSim, from: change.from, to: change.to, cause: change.cause, actor: change.actor },
    })),
    ...notes.map((note) => ({
      type: "NOTE",
      atSim: note.atSim,
      real: note.createdAt,
      id: note.noteId,
      item: { type: "NOTE" as const, atSim: note.atSim, noteId: note.noteId, kind: note.kind, author: note.author, text: note.text, task: note.task ?? null },
    })),
  ]);
  const waiting = pending
    .filter((item) => item.complaintId === complaintId || (item.complaintId === undefined && item.customerId === customerId))
    .map((item) => ({ kind: item.kind, pendingId: item.pendingId, openedAtReal: item.openedAtReal, reason: item.kind === "MAIL" ? "WAITING_EMAIL_EVENT" : "WAITING_IMAGE_SCAN" }));
  return { complaintId, complaintNumber: complaint.complaintNumber, items, pending: waiting };
}

async function evidenceFile(ctx: WorldContext, services: OperationsServices, complaint: Complaint, evidenceId: string) {
  const evidence = await services.data.caseItems.getEvidence(ctx.principal.worldId, complaint.complaintId, evidenceId);
  if (evidence === undefined) throw new ToolError("NOT_FOUND", "no such evidence in this complaint");
  if (evidence.kind !== "RECEIPT_IMAGE") throw new ToolError("EVIDENCE_REQUIRED", "only a receipt image has a file", "NOT_AN_IMAGE");
  const parsed = ReceiptImageDetails.safeParse(evidence.details);
  if (!parsed.success) throw new ToolError("EVIDENCE_REQUIRED", "the evidence does not point to an image", "IMAGE_DETAILS");
  const image = parsed.data;
  const base = { evidenceId, contentType: image.contentType, sha256: image.sha256 };
  if ("seedKey" in image || image.scan === "SEED_SKIPPED") {
    // A synthetic receipt only when its hash is one the seed rendered (receipts/seed-hash.ts).
    if (!(await isSeedReceiptHash(services.data, image.sha256))) throw new ToolError("EVIDENCE_REQUIRED", "the image is not a known synthetic receipt", "UNKNOWN_SEED_HASH");
  }
  if (!("seedKey" in image)) return { ...base, kind: "URL" as const, url: await services.presignMedia(image.s3Key, image.contentType), expiresInSeconds: EVIDENCE_URL_SECONDS };
  const bytes = await services.images().get({ bucket: "Seed", key: image.seedKey }, MAX_IMAGE_BYTES);
  if (bytes === undefined) throw new ToolError("NOT_FOUND", "the receipt image is no longer available");
  if (bytes === "TOO_LARGE" || sha256Hex(bytes) !== image.sha256) throw new ToolError("EVIDENCE_REQUIRED", "the receipt image changed after it was checked", "IMAGE_CHANGED");
  return { ...base, kind: "INLINE" as const, dataBase64: Buffer.from(bytes).toString("base64") };
}

const AnswerInput = ComplaintRef.extend({
  outcome: ComplaintOutcome,
  draftBody: z.string().trim().min(1).max(5_000),
  requestedAttachments: z.array(AnswerAttachment).max(3).default([]),
}).strict();

const EscalateInput = ComplaintRef.extend({ reason: HandoffReason.default("OTHER"), summary: z.string().trim().min(1).max(500).optional() }).strict();

const NoteInput = ComplaintRef.extend({ text: z.string().trim().min(1).max(2_000) }).strict();

export const complaintsRouter = router({
  get: accessProcedure("complaints.get")
    .input(ComplaintRef)
    .query(async ({ ctx, input, path }) => {
      const { services, complaint } = await referenced(ctx, path, input);
      return caseView(ctx, services, complaint);
    }),

  timeline: accessProcedure("complaints.timeline")
    .input(ComplaintRef)
    .query(async ({ ctx, input, path }) => {
      const { services, complaint } = await referenced(ctx, path, input);
      return timelineOf(ctx, services, complaint);
    }),

  evidenceUrl: accessProcedure("complaints.evidenceUrl")
    .input(ComplaintRef.extend({ evidenceId: Id }).strict())
    .query(async ({ ctx, input, path }) => {
      const { services, complaint } = await referenced(ctx, path, input);
      return evidenceFile(ctx, services, complaint, input.evidenceId);
    }),

  answer: accessProcedure("complaints.answer")
    .input(AnswerInput)
    .mutation(async ({ ctx, input, path }) => {
      const { services, complaint } = await referenced(ctx, path, input);
      // The worker answers as `OPERATOR:<staffId>`: the same preconditions it will check, checked first.
      checkAnswerPreconditions(complaint, `OPERATOR:${ctx.principal.staffId}`);
      const { simNow } = await worldTime(ctx, services);
      const messageId = services.newId("ans");
      const eventId = await enqueueAs(ctx, services, {
        type: "OPERATOR_ANSWER",
        eventId: `evt-${messageId}`,
        customerId: complaint.customerId,
        eventAtSim: simNow.toISOString(),
        payload: {
          staffId: ctx.principal.staffId,
          messageId,
          complaintId: complaint.complaintId,
          outcome: input.outcome,
          draftBody: input.draftBody,
          requestedAttachments: input.requestedAttachments,
        },
      });
      return { status: "QUEUED" as const, messageId, eventId };
    }),

  escalate: accessProcedure("complaints.escalate")
    .input(EscalateInput)
    .mutation(async ({ ctx, input, path }) => {
      const { services, complaint } = await referenced(ctx, path, input);
      if (complaint.status === "HUMAN_REVIEW") return { status: complaint.status, already: true };
      if (!canTransition(complaint.status, "HUMAN_REVIEW")) throw new ToolError("NOT_ELIGIBLE", `a ${complaint.status} complaint cannot be escalated`, "CANNOT_ESCALATE");
      const { simNow } = await worldTime(ctx, services);
      const atSim = simNow.toISOString();
      const summary = input.summary === undefined ? {} : { summary: maskSensitive(input.summary) };
      const result = await transition(services.chains(), {
        worldId: ctx.principal.worldId,
        complaintId: complaint.complaintId,
        to: "HUMAN_REVIEW",
        cause: `ESCALATED_${input.reason}`,
        actor: actorOfCtx(ctx),
        atSim,
        complaint,
        patch: { handoff: { reason: input.reason, atSim, ...summary } },
        extra: () => [auditOp(ctx, services, { action: "ESCALATED", outcome: input.reason, atSim: simNow, refs: { complaintId: complaint.complaintId } })],
      });
      return { status: result.complaint.status, already: false };
    }),

  note: accessProcedure("complaints.note")
    .input(NoteInput)
    .mutation(async ({ ctx, input, path }) => {
      const { services, complaint } = await referenced(ctx, path, input);
      const { simNow } = await worldTime(ctx, services);
      const noteId = services.newId("note");
      await services.data.caseItems.putNote({
        worldId: ctx.principal.worldId,
        complaintId: complaint.complaintId,
        noteId,
        kind: "NOTE",
        atSim: simNow.toISOString(),
        author: actorOfCtx(ctx),
        text: maskSensitive(input.text),
      });
      return { noteId, atSim: simNow.toISOString() };
    }),
});
