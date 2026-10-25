/// <reference path="../../sst-env.d.ts" />
// `inbox` router (docs/tool-catalog.md "Procedimientos de la consola", docs/design-brief.md §9, FL-097)
// and the services every operations router (`inbox`, `complaints`, `conversation`, `customers`,
// `approvals`) runs on besides `ctx.deps`:
//
//   data       the connector; every key under the principal's `W#<worldId>#`
//   chains     complaints/deps.ts: the register chain key and `AnchorWriter`, for the transitions and the
//              tape entries the console writes (escalate, reject, reroute to the human queue)
//   enqueuer   worker/enqueue.ts, the only producer: the console never sends, it enqueues
//              `OPERATOR_SEND`, `OPERATOR_ANSWER`, `APPROVAL_DECIDED` and `OPERATOR_RELEASED`
//   core       the lender core in read mode (`customers.get`)
//   images     `Seed` receipts (read, checked against their hash) and the 5-minute GET of a `Media` image
//
// A Lambda builds them once per container on first use (nothing is read at import time); tests and the
// local UI server bind their own to their `ContextDeps` with `bindOperations`.
//
//   list   open (or also closed) complaints by deadline, with the business days left counted by
//          services/business-days.ts, `slaState`, the next milestone, who blocks (customer, network, a
//          person, the agent) and the open human tasks; `R-2026-000123` pinned as the main story
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { type Caller, ComplaintStatus, ComplaintType, PresentationKind, SlaMilestone, SlaState, ToolError, WorldId, businessDaysBetween } from "@reclamo/shared";
import { actorOf } from "../auth/audit";
import type { CoreReader } from "../agent-tools/account/core";
import { type ComplaintsDeps, stageComplaintsDeps } from "../complaints/deps";
import { complaintOwnerKey, deadlineText, loadHolidays, slaStateAt } from "../complaints/sla";
import { viewOf } from "../clock/state";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import { linkedCoreClient } from "../core/linked";
import type { Note } from "../domain/case-items";
import { Actor } from "../domain/common";
import { type Complaint, Control, INBOX_CLOSED_STATUSES } from "../domain/complaint";
import { awsClientConfig } from "../lib/clients";
import { ulid } from "../lib/crypto";
import { type Logger, createLogger } from "../lib/log";
import { bucketName } from "../lib/resource";
import { s3ImageStore } from "../receipts/linked";
import { S3_TIMEOUTS } from "../receipts/s3-object";
import type { ImageStore } from "../receipts/service";
import { localDateAr } from "../services/business-days";
import { type Enqueuer, linkedEnqueuer } from "../worker/enqueue";
import type { CustomerEventInput } from "../worker/events";
import type { ContextDeps } from "./deps";
import { accessProcedure } from "./roles";
import { type WorldContext, assertWorld, router } from "./trpc";

// ---- Services of the operations routers ------------------------------------------------------------

/** The GET of one `Media` object, signed for 5 minutes with the content type fixed by the code. */
export type MediaPresigner = (key: string, contentType: string) => Promise<string>;

export interface OperationsServices {
  readonly data: Connector;
  readonly chains: () => ComplaintsDeps;
  readonly enqueuer: (log: Logger) => Enqueuer;
  readonly core: () => CoreReader;
  readonly images: () => ImageStore;
  readonly presignMedia: MediaPresigner;
  /** New ids (`note-…`, `aud-…`, `evt-…`); deterministic in tests. */
  readonly newId: (prefix: string) => string;
}

/** How long a presigned GET of an evidence image lives (docs/architecture.md §11). */
export const EVIDENCE_URL_SECONDS = 300;

function stageOperations(): OperationsServices {
  const log = createLogger({ bindings: { service: "bff-operations" } });
  const data = dynamoConnector();
  let chains: ComplaintsDeps | undefined;
  let images: ImageStore | undefined;
  let s3: S3Client | undefined;
  const client = (): S3Client => (s3 ??= new S3Client({ region: "us-east-1", ...awsClientConfig(S3_TIMEOUTS) }));
  return {
    data,
    chains: () => (chains ??= stageComplaintsDeps({ log })),
    enqueuer: (requestLog) => linkedEnqueuer(data, requestLog),
    core: linkedCoreClient,
    images: () => (images ??= s3ImageStore({ Media: bucketName("Media"), Seed: bucketName("Seed") }, client())),
    presignMedia: (key, contentType) =>
      getSignedUrl(client(), new GetObjectCommand({ Bucket: bucketName("Media"), Key: key, ResponseContentType: contentType }), { expiresIn: EVIDENCE_URL_SECONDS }),
    newId: (prefix) => `${prefix}-${ulid().toLowerCase()}`,
  };
}

const bound = new WeakMap<ContextDeps, OperationsServices>();
let stage: OperationsServices | undefined;

/** The services every operations router of a request with these dependencies uses (tests, the UI server). */
export function bindOperations(deps: ContextDeps, services: OperationsServices): ContextDeps {
  bound.set(deps, services);
  return deps;
}

/** The services bound to `deps`, else the stage's (built once per container). */
export function operationsOf(deps: ContextDeps): OperationsServices {
  return bound.get(deps) ?? (stage ??= stageOperations());
}

// ---- What every operations procedure shares ---------------------------------------------------------

/** The world an input names, when it names one: another world is refused with 403 `CROSS_WORLD`. */
export const WorldScoped = { worldId: WorldId.optional() };

/** 403 + `AuditLog DENY CROSS_WORLD` when the input names a world other than the principal's. */
export async function checkWorld(ctx: WorldContext, path: string, input: { readonly worldId?: string | undefined }): Promise<void> {
  if (input.worldId !== undefined) await assertWorld(ctx, path, input.worldId);
}

/** `OPERATOR:<staffId>` for staff, `QA` for the QaDriver's in-process principal. */
export function actorOfCtx(ctx: WorldContext): Actor {
  return Actor.parse(actorOf(ctx.principal));
}

/** The principal as a caller of the in-process handlers (the producer refuses another world). */
export function callerOf(ctx: WorldContext, eventId: string): Caller {
  if (ctx.principal.audience === "in-process") return { kind: "QA", worldId: ctx.principal.worldId, staffId: ctx.principal.staffId, role: ctx.principal.role, eventId };
  return { kind: "CONSOLE", worldId: ctx.principal.worldId, staffId: ctx.principal.staffId, role: ctx.principal.role, eventId };
}

export interface WorldTime {
  /** The world's simulated now (ADR-0011); a read never writes the clock back. */
  readonly simNow: Date;
  /** Real now: audit stamps and the challenge window only. */
  readonly realNow: Date;
}

export async function worldTime(ctx: WorldContext, services: OperationsServices): Promise<WorldTime> {
  const realNow = ctx.deps.wallClock();
  const stored = await services.data.runtime.getClock(ctx.principal.worldId);
  if (stored === undefined) throw new ToolError("NOT_FOUND", "this world has no clock", "CLOCK_MISSING");
  return { simNow: viewOf(stored, realNow).simNow, realNow };
}

/** An `AuditLog` row of a console action, as an operation that commits with the action it records. */
export function auditOp(ctx: WorldContext, services: OperationsServices, entry: { action: string; outcome?: string; atSim: Date; refs: Record<string, string>; ruleIds?: string[] }) {
  const refs: Record<string, string> = { ...entry.refs, staffId: ctx.principal.staffId };
  const primaryRef = refs["complaintId"] !== undefined ? `CMP#${refs["complaintId"]}` : refs["customerId"] !== undefined ? `CUS#${refs["customerId"]}` : undefined;
  return services.data.audit.appendOp({
    worldId: ctx.principal.worldId,
    epoch: ctx.world.epoch,
    auditId: services.newId("aud"),
    ts: ctx.deps.wallClock().toISOString(),
    atSim: entry.atSim.toISOString(),
    action: entry.action,
    actor: actorOfCtx(ctx),
    refs,
    ...(primaryRef === undefined ? {} : { primaryRef }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
    ...(entry.ruleIds === undefined ? {} : { ruleIds: entry.ruleIds }),
  });
}

/** A complaint of the principal's world, read strongly consistent; `NOT_FOUND` otherwise. */
export async function complaintOf(ctx: WorldContext, services: OperationsServices, complaintId: string): Promise<Complaint> {
  const complaint = await services.data.complaints.get(ctx.principal.worldId, complaintId, { consistent: true });
  if (complaint === undefined) throw new ToolError("NOT_FOUND", "no such complaint in this world");
  return complaint;
}

/** Enqueues one customer event as the principal (`worker/enqueue.ts`, the only producer). */
export async function enqueueAs(ctx: WorldContext, services: OperationsServices, event: Omit<CustomerEventInput, "worldId" | "epoch" | "correlationId"> & { readonly epoch?: number }): Promise<string> {
  const input = { ...event, worldId: ctx.principal.worldId, epoch: event.epoch ?? ctx.world.epoch, correlationId: ctx.correlationId } as CustomerEventInput;
  const queued = await services.enqueuer(ctx.log).enqueueCustomerEvent(input, callerOf(ctx, event.eventId));
  return queued.eventId;
}

// ---- inbox.list -----------------------------------------------------------------------------------

/** The main story (`docs/design-brief.md` §9): pinned at the top of the inbox. */
export const MAIN_STORY_NUMBER = "R-2026-000123";

/** Who the complaint waits for (FL-097): network waits are never shown as the customer's. */
export const BlockedBy = z.enum(["CUSTOMER", "NETWORK", "PERSON", "AGENT", "NONE"]);
export type BlockedBy = z.infer<typeof BlockedBy>;

export function blockedByOf(complaint: Pick<Complaint, "status" | "control">): BlockedBy {
  if (INBOX_CLOSED_STATUSES.has(complaint.status)) return "NONE";
  if (complaint.control === "OPERATOR") return "PERSON";
  switch (complaint.status) {
    case "AWAITING_CUSTOMER":
      return "CUSTOMER";
    case "AWAITING_SETTLEMENT":
    case "AWAITING_NETWORK":
      return "NETWORK";
    case "AWAITING_APPROVAL":
    case "HUMAN_REVIEW":
      return "PERSON";
    default:
      return "AGENT";
  }
}

const InboxInput = z
  .object({
    type: z.array(ComplaintType).max(11).optional(),
    kind: PresentationKind.optional(),
    status: z.array(ComplaintStatus).max(10).optional(),
    control: Control.optional(),
    slaState: z.array(SlaState).max(3).optional(),
    blockedBy: z.array(BlockedBy).max(5).optional(),
    includeClosed: z.boolean().optional(),
  })
  .strict()
  .optional();
type InboxFilters = NonNullable<z.infer<typeof InboxInput>>;

const SLA_RANK: Readonly<Record<SlaState, number>> = { ON_TIME: 0, AT_RISK: 1, OVERDUE: 2 };

function matches(item: { complaint: Complaint; slaState: SlaState; blockedBy: BlockedBy }, filters: InboxFilters): boolean {
  const { complaint } = item;
  if (filters.type && !filters.type.includes(complaint.type)) return false;
  if (filters.kind && filters.kind !== complaint.kind) return false;
  if (filters.status && !filters.status.includes(complaint.status)) return false;
  if (filters.control && filters.control !== complaint.control) return false;
  if (filters.slaState && !filters.slaState.includes(item.slaState)) return false;
  return !(filters.blockedBy && !filters.blockedBy.includes(item.blockedBy));
}

function openTasks(notes: readonly Note[]): number {
  return notes.filter((note) => note.kind === "HUMAN_TASK" && note.task?.status === "OPEN").length;
}

async function inboxItem(ctx: WorldContext, services: OperationsServices, complaint: Complaint, simNow: Date, holidays: readonly string[]) {
  const worldId = ctx.principal.worldId;
  const [timers, notes] = await Promise.all([services.data.timers.listByOwner(worldId, complaintOwnerKey(complaint.complaintId)), services.data.caseItems.listNotes(worldId, complaint.complaintId)]);
  const computed = slaStateAt({ filedAtSim: complaint.filedAtSim, deadlineSim: complaint.deadlineSim, ...(complaint.answer?.sentAtSim ? { answeredAtSim: complaint.answer.sentAtSim } : {}), simNow, holidays });
  // A milestone that already fired may have raised it; the inbox never shows less than either.
  const slaState = SLA_RANK[complaint.slaState] >= SLA_RANK[computed] ? complaint.slaState : computed;
  const next = timers.filter((timer) => timer.kind === "SLA" && timer.status === "SCHEDULED").sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim))[0];
  return {
    complaint,
    slaState,
    blockedBy: blockedByOf(complaint),
    view: {
      complaintId: complaint.complaintId,
      complaintNumber: complaint.complaintNumber,
      kind: complaint.kind,
      type: complaint.type,
      status: complaint.status,
      priority: complaint.priority,
      control: complaint.control,
      origin: complaint.origin,
      customerId: complaint.customerId,
      summary: complaint.summary,
      filedAtSim: complaint.filedAtSim,
      deadlineSim: complaint.deadlineSim,
      deadlineText: deadlineText(complaint.deadlineSim),
      businessDaysLeft: businessDaysBetween(localDateAr(simNow), localDateAr(new Date(complaint.deadlineSim)), holidays),
      slaState,
      nextMilestone: next === undefined ? null : { milestone: SlaMilestone.safeParse(next.payload["milestone"]).data ?? null, dueAtSim: next.dueAtSim, dueText: deadlineText(next.dueAtSim) },
      blockedBy: blockedByOf(complaint),
      openTasks: openTasks(notes),
      handoffReason: complaint.handoff?.reason ?? null,
      pinned: complaint.complaintNumber === MAIN_STORY_NUMBER,
    },
  };
}

export const inboxRouter = router({
  list: accessProcedure("inbox.list")
    .input(InboxInput)
    .query(async ({ ctx, input }) => {
      const services = operationsOf(ctx.deps);
      const worldId = ctx.principal.worldId;
      const filters: InboxFilters = input ?? {};
      const [{ simNow }, holidays, open, closed] = await Promise.all([
        worldTime(ctx, services),
        loadHolidays(services.data),
        services.data.complaints.listOpen(worldId),
        filters.includeClosed ? services.data.complaints.listInbox(worldId, { state: "CLOSED", limit: 100 }).then((page) => page.complaints) : Promise.resolve([]),
      ]);
      const items = await Promise.all([...open, ...closed].map((complaint) => inboxItem(ctx, services, complaint, simNow, holidays)));
      const views = items
        .filter((item) => matches(item, filters))
        .map((item) => item.view)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(a.deadlineSim) - Date.parse(b.deadlineSim) || a.complaintNumber.localeCompare(b.complaintNumber));
      return { simNow: simNow.toISOString(), total: items.length, items: views };
    }),
});
