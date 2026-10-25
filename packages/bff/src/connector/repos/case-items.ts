// What hangs from a complaint: evidence, actions, approvals and their single execution, notes and
// human tasks. Creations never overwrite (`attribute_not_exists`); an approval is decided once
// (`decision = PENDING` and its version) and executed once (`EXEC#` plus `executedAt`, §8.5).
import { ConnectorError } from "@reclamo/shared";
import { Action, Approval, type ApprovalDecision, Evidence, Execution, Note } from "../../domain/case-items";
import { Complaint } from "../../domain/complaint";
import { type CreateMode, type NewOf, type RepoContext, createGuard, decode, decodeOptional, encode, queryAll, validInput } from "../codec";
import { keys, sortInstant, worldIndexAttributes, worldKey } from "../keys";
import type { RetentionRule } from "../ttl";
import { type StoredItem, type WriteOp, cond } from "../store";

const TABLE = "Complaints" as const;
const RETENTION: RetentionRule = "complaint";

export interface CaseFile {
  readonly complaint?: Complaint;
  readonly evidence: Evidence[];
  readonly actions: Action[];
  readonly approvals: Approval[];
  readonly executions: Execution[];
  readonly notes: Note[];
}

/** A new approval: always `PENDING`, so nothing about a decision is accepted. */
export type NewApproval = Omit<NewOf<typeof Approval>, "decision" | "decidedBy" | "decidedAtSim" | "reason" | "executedAt">;

export interface ApprovalDecisionRequest {
  readonly worldId: string;
  readonly complaintId: string;
  readonly approvalId: string;
  readonly version: number;
  readonly decision: Exclude<ApprovalDecision, "PENDING">;
  readonly decidedBy?: string;
  readonly decidedAtSim: string;
  readonly reason?: string;
}

export function caseItemsRepo(ctx: RepoContext) {
  const putNew = (entity: string, value: { worldId: string }, key: { pk: string; sk: string }, mode: CreateMode, indexes: Record<string, string | undefined> = {}): WriteOp => ({
    kind: "put",
    table: TABLE,
    item: encode(value, { entity, key, worldId: value.worldId, retention: RETENTION, now: ctx.now(), indexes: { ...indexes, ...worldIndexAttributes(value.worldId, key) } }),
    ...createGuard(mode),
  });

  const listPrefix = async (worldId: string, complaintId: string, prefix: string): Promise<StoredItem[]> =>
    queryAll(ctx.store, { table: TABLE, partition: keys.complaintPartition(worldId, complaintId), sort: { op: "beginsWith", value: prefix } });

  const evidenceOp = (evidence: NewOf<typeof Evidence>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(Evidence, evidence, TABLE);
    return putNew("Evidence", value, keys.evidence(value.worldId, value.complaintId, value.evidenceId), mode);
  };
  const actionOp = (action: NewOf<typeof Action>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(Action, action, TABLE);
    return putNew("Action", value, keys.action(value.worldId, value.complaintId, value.actionId), mode);
  };
  const approvalItemOp = (value: Approval, mode: CreateMode): WriteOp =>
    // Sparse `ApprovalIndex`: only a pending approval is in it.
    putNew(
      "Approval",
      value,
      keys.approval(value.worldId, value.complaintId, value.approvalId),
      mode,
      value.decision === "PENDING" ? { approvalKey: worldKey(value.worldId, "PENDING"), requestedAtSort: sortInstant(value.requestedAtSim) } : {},
    );
  const approvalOp = (approval: NewApproval): WriteOp => approvalItemOp(validInput(Approval, { ...approval, decision: "PENDING", version: 1 }, TABLE), {});
  const noteOp = (note: NewOf<typeof Note>, mode: CreateMode = {}): WriteOp => {
    const value = validInput(Note, note, TABLE);
    return putNew("Note", value, keys.note(value.worldId, value.complaintId, value.atSim, value.noteId), mode);
  };

  return {
    putEvidenceOp: evidenceOp,
    async putEvidence(evidence: NewOf<typeof Evidence>): Promise<void> {
      await ctx.store.write(evidenceOp(evidence));
    },
    async getEvidence(worldId: string, complaintId: string, evidenceId: string): Promise<Evidence | undefined> {
      return decodeOptional(Evidence, await ctx.store.get(TABLE, keys.evidence(worldId, complaintId, evidenceId), { consistent: true }), TABLE);
    },
    async listEvidence(worldId: string, complaintId: string): Promise<Evidence[]> {
      return (await listPrefix(worldId, complaintId, "EVD#")).map((item) => decode(Evidence, item, TABLE));
    },

    putActionOp: actionOp,
    async putAction(action: NewOf<typeof Action>): Promise<void> {
      await ctx.store.write(actionOp(action));
    },
    async getAction(worldId: string, complaintId: string, actionId: string): Promise<Action | undefined> {
      return decodeOptional(Action, await ctx.store.get(TABLE, keys.action(worldId, complaintId, actionId), { consistent: true }), TABLE);
    },
    async listActions(worldId: string, complaintId: string): Promise<Action[]> {
      return (await listPrefix(worldId, complaintId, "ACT#")).map((item) => decode(Action, item, TABLE));
    },

    /** A new approval, always `PENDING` (no path creates a decided one). */
    createApprovalOp: approvalOp,
    async createApproval(approval: NewApproval): Promise<void> {
      await ctx.store.write(approvalOp(approval));
    },
    /** The factory's idempotent rewrite of a template approval, decided or not, as the template has it. */
    restoreApprovalOp(approval: NewOf<typeof Approval>): WriteOp {
      return approvalItemOp(validInput(Approval, { ...approval, version: 1 }, TABLE), { replace: true });
    },
    /** Read strongly consistent: `execute_approved_action` never trusts an event's payload (§8.5). */
    async getApproval(worldId: string, complaintId: string, approvalId: string): Promise<Approval | undefined> {
      return decodeOptional(Approval, await ctx.store.get(TABLE, keys.approval(worldId, complaintId, approvalId), { consistent: true }), TABLE);
    },
    /** Pending approvals of the world, oldest first (index `ApprovalIndex`). */
    async listPendingApprovals(worldId: string, limit = 100): Promise<Approval[]> {
      const page = await ctx.store.query({ table: TABLE, index: "ApprovalIndex", partition: worldKey(worldId, "PENDING"), limit });
      return page.items.map((item) => decode(Approval, item, TABLE));
    },
    /** Decides a pending approval once, on its version; it leaves the pending index. */
    decideApprovalOp(request: ApprovalDecisionRequest): WriteOp {
      if (request.decision === "APPROVED" && !request.decidedBy) throw new ConnectorError("VALIDATION", "an approval is decided by a staff member", TABLE);
      return {
        kind: "update",
        table: TABLE,
        key: keys.approval(request.worldId, request.complaintId, request.approvalId),
        condition: cond.and(cond.eq("version", request.version), cond.eq("decision", "PENDING")),
        update: {
          set: {
            decision: request.decision,
            decidedBy: request.decidedBy,
            decidedAtSim: request.decidedAtSim,
            reason: request.reason,
            version: request.version + 1,
            updatedAt: ctx.now().toISOString(),
          },
          remove: ["approvalKey", "requestedAtSort"],
        },
      };
    },
    /** `SET executedAt` on an approved, not yet executed approval: rides with `putExecutionOp`. */
    markExecutedOp(worldId: string, complaintId: string, approvalId: string, executedAt: string): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: keys.approval(worldId, complaintId, approvalId),
        condition: cond.and(cond.eq("decision", "APPROVED"), cond.exists("decidedBy"), cond.notExists("executedAt")),
        update: { set: { executedAt: sortInstant(executedAt), updatedAt: ctx.now().toISOString() }, add: { version: 1 } },
      };
    },
    /** `EXEC#<approvalId>`, written once whatever the number of `APPROVAL_DECIDED` events. */
    putExecutionOp(execution: NewOf<typeof Execution>, mode: CreateMode = {}): WriteOp {
      const value = validInput(Execution, execution, TABLE);
      return putNew("Execution", value, keys.execution(value.worldId, value.complaintId, value.approvalId), mode);
    },
    async getExecution(worldId: string, complaintId: string, approvalId: string): Promise<Execution | undefined> {
      return decodeOptional(Execution, await ctx.store.get(TABLE, keys.execution(worldId, complaintId, approvalId), { consistent: true }), TABLE);
    },

    putNoteOp: noteOp,
    async putNote(note: NewOf<typeof Note>): Promise<void> {
      await ctx.store.write(noteOp(note));
    },
    async listNotes(worldId: string, complaintId: string): Promise<Note[]> {
      return (await listPrefix(worldId, complaintId, "NOTE#")).map((item) => decode(Note, item, TABLE));
    },
    /** Closes an open human task once. */
    completeTaskOp(worldId: string, complaintId: string, note: { atSim: string; noteId: string }, done: { doneBy: string; doneAtSim: string }): WriteOp {
      return {
        kind: "update",
        table: TABLE,
        key: keys.note(worldId, complaintId, note.atSim, note.noteId),
        condition: cond.eq("task.status", "OPEN"),
        update: { set: { "task.status": "DONE", "task.doneBy": done.doneBy, "task.doneAtSim": done.doneAtSim, updatedAt: ctx.now().toISOString() } },
      };
    },

    /** The whole partition of a complaint in one query: the case view and the QA snapshot. */
    async caseFile(worldId: string, complaintId: string): Promise<CaseFile> {
      const items = await queryAll(ctx.store, { table: TABLE, partition: keys.complaintPartition(worldId, complaintId), consistent: true });
      const of = <T>(prefix: string, parse: (item: StoredItem) => T): T[] => items.filter((item) => item.sk.startsWith(prefix)).map(parse);
      const meta = items.find((item) => item.sk === "META");
      return {
        ...(meta ? { complaint: decode(Complaint, meta, TABLE) } : {}),
        evidence: of("EVD#", (item) => decode(Evidence, item, TABLE)),
        actions: of("ACT#", (item) => decode(Action, item, TABLE)),
        approvals: of("APR#", (item) => decode(Approval, item, TABLE)),
        executions: of("EXEC#", (item) => decode(Execution, item, TABLE)),
        notes: of("NOTE#", (item) => decode(Note, item, TABLE)),
      };
    },
  };
}

export type CaseItemsRepo = ReturnType<typeof caseItemsRepo>;
