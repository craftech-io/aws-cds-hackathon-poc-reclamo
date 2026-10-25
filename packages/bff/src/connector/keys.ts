// Every key of every item the connector writes (docs/architecture.md §5), built in one place from
// validated parts. A world's partition always starts with `W#<worldId>#`; an id that goes into a
// key never carries `#`, `/` or whitespace, so no input can address another item, another entity or
// another world. Instants in sort keys are normalized to UTC ISO (`toISOString`), which orders as a
// string whatever offset the caller wrote.
import { ConnectorError, WorldId, worldKeyPrefix } from "@reclamo/shared";
import type { Key } from "./store";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:+=@-]{0,159}$/;

/** A key segment (an id): refused when it could escape its position in the key. */
export function segment(value: string, label: string): string {
  if (!SEGMENT.test(value)) throw new ConnectorError("VALIDATION", `invalid ${label}`);
  return value;
}

/** `W#<worldId>#`, for a valid world id only. */
export function worldPrefix(worldId: string): string {
  if (!WorldId.safeParse(worldId).success) throw new ConnectorError("VALIDATION", "invalid world id");
  return worldKeyPrefix(worldId);
}

/** `W#<worldId>#<rest>` with every part checked. */
export function worldKey(worldId: string, ...parts: string[]): string {
  return worldPrefix(worldId) + parts.join("#");
}

/** An instant as a sortable UTC string. */
export function sortInstant(instant: string): string {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) throw new ConnectorError("VALIDATION", "invalid instant");
  return new Date(time).toISOString();
}

/** Zero-padded sequence number, the sort key of a chained entry (`000000042`). */
export function paddedSeq(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 999_999_999) throw new ConnectorError("VALIDATION", `invalid sequence number ${seq}`);
  return seq.toString().padStart(9, "0");
}

function epochPart(epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ConnectorError("VALIDATION", `invalid epoch ${epoch}`);
  return `e${epoch}`;
}

export const META = "META";

export const keys = {
  // Worlds
  worldMeta: (worldId: string): Key => ({ pk: worldKey(worldId, "WORLD"), sk: META }),
  worldSettings: (worldId: string): Key => ({ pk: worldKey(worldId, "WORLD"), sk: "SETTINGS" }),
  staff: (worldId: string, staffId: string): Key => ({ pk: worldKey(worldId, "WORLD"), sk: `STAFF#${segment(staffId, "staff id")}` }),
  staffPrefix: "STAFF#",
  subKey: (sub: string): string => `SUB#${segment(sub, "cognito sub")}`,

  // Complaints
  complaintPartition: (worldId: string, complaintId: string): string => worldKey(worldId, "CMP", segment(complaintId, "complaint id")),
  complaint: (worldId: string, complaintId: string): Key => ({ pk: keys.complaintPartition(worldId, complaintId), sk: META }),
  evidence: (worldId: string, complaintId: string, evidenceId: string): Key => ({
    pk: keys.complaintPartition(worldId, complaintId),
    sk: `EVD#${segment(evidenceId, "evidence id")}`,
  }),
  action: (worldId: string, complaintId: string, actionId: string): Key => ({ pk: keys.complaintPartition(worldId, complaintId), sk: `ACT#${segment(actionId, "action id")}` }),
  approval: (worldId: string, complaintId: string, approvalId: string): Key => ({
    pk: keys.complaintPartition(worldId, complaintId),
    sk: `APR#${segment(approvalId, "approval id")}`,
  }),
  execution: (worldId: string, complaintId: string, approvalId: string): Key => ({
    pk: keys.complaintPartition(worldId, complaintId),
    sk: `EXEC#${segment(approvalId, "approval id")}`,
  }),
  note: (worldId: string, complaintId: string, atSim: string, noteId: string): Key => ({
    pk: keys.complaintPartition(worldId, complaintId),
    sk: `NOTE#${sortInstant(atSim)}#${segment(noteId, "note id")}`,
  }),

  // Register, refund register, tape, audit (append-only)
  register: (worldId: string, epoch: number, seq: number): Key => ({ pk: worldKey(worldId, "REG", epochPart(epoch)), sk: paddedSeq(seq) }),
  refund: (worldId: string, epoch: number, seq: number): Key => ({ pk: worldKey(worldId, "RRI", epochPart(epoch)), sk: paddedSeq(seq) }),
  tapeDay: (worldId: string, day: string): string => worldKey(worldId, "TAPE", segment(day, "tape day")),
  tape: (worldId: string, day: string, atSim: string, tapeId: string): Key => ({ pk: keys.tapeDay(worldId, day), sk: `${sortInstant(atSim)}#${segment(tapeId, "tape id")}` }),
  auditPartition: (worldId: string, epoch: number, month: string): string => worldKey(worldId, "AUD", epochPart(epoch), segment(month, "audit month")),
  audit: (worldId: string, epoch: number, ts: string, auditId: string): Key => {
    const at = sortInstant(ts);
    return { pk: keys.auditPartition(worldId, epoch, at.slice(0, 7)), sk: `${at}#${segment(auditId, "audit id")}` };
  },

  // Timers
  timer: (worldId: string, kind: string, timerId: string): Key => ({ pk: keys.timerKey(worldId, kind, timerId), sk: META }),
  timerKey: (worldId: string, kind: string, timerId: string): string => worldKey(worldId, "TIMER", segment(kind, "timer kind"), segment(timerId, "timer id")),

  // Conversations
  conversationPartition: (worldId: string, customerId: string): string => worldKey(worldId, "CONV", segment(customerId, "customer id")),
  conversation: (worldId: string, customerId: string): Key => ({ pk: keys.conversationPartition(worldId, customerId), sk: META }),
  message: (worldId: string, customerId: string, atSim: string, messageId: string): Key => ({
    pk: keys.conversationPartition(worldId, customerId),
    sk: `MSG#${sortInstant(atSim)}#${segment(messageId, "message id")}`,
  }),
  messageEvent: (worldId: string, customerId: string, at: string, eventId: string): Key => ({
    pk: keys.conversationPartition(worldId, customerId),
    sk: `EVT#${sortInstant(at)}#${segment(eventId, "event id")}`,
  }),
  turnNote: (worldId: string, customerId: string, atSim: string, turnId: string): Key => ({
    pk: keys.conversationPartition(worldId, customerId),
    sk: `NOTE#${sortInstant(atSim)}#${segment(turnId, "turn id")}`,
  }),
  conversationTask: (worldId: string, customerId: string, atSim: string, taskId: string): Key => ({
    pk: keys.conversationPartition(worldId, customerId),
    sk: `TASK#${sortInstant(atSim)}#${segment(taskId, "task id")}`,
  }),
  email: (worldId: string, customerId: string, sentAtSim: string, mailId: string): Key => ({
    pk: keys.conversationPartition(worldId, customerId),
    sk: `MAIL#${sortInstant(sentAtSim)}#${segment(mailId, "mail id")}`,
  }),

  // Runtime, per world
  runtime: (worldId: string, ...parts: string[]): Key => ({ pk: worldKey(worldId, ...parts), sk: META }),
  counter: (worldId: string, ...parts: string[]): Key => ({ pk: worldKey(worldId, "COUNTER", ...parts), sk: META }),
  epochPart,
  pendingPartition: (worldId: string): string => worldKey(worldId, "PENDING"),
  pending: (worldId: string, kind: "MAIL" | "SCAN", id: string): Key => ({ pk: worldKey(worldId, "PENDING"), sk: `${kind}#${segment(id, "pending id")}` }),
  turnResult: (worldId: string, turnId: string, tool: string, seq: number): Key => ({
    pk: worldKey(worldId, "TURN", segment(turnId, "turn id")),
    sk: `RESULT#${segment(tool, "tool")}#${paddedSeq(seq)}`,
  }),

  // Runtime, global (no world): the only partitions outside a world (docs/architecture.md §5)
  global: (...parts: string[]): Key => ({ pk: parts.join("#"), sk: META }),

  // Metrics and reference
  metricsPartition: (worldId: string): string => worldKey(worldId, "METRICS"),
  metric: (worldId: string, source: string, runId: string, complaintId: string): Key => ({
    pk: keys.metricsPartition(worldId),
    sk: `${segment(source, "metric source")}#${segment(runId, "run id")}#${segment(complaintId, "complaint id")}`,
  }),
  referencePartition: (type: string, scope: string): string => `REF#${segment(type, "reference type")}#${segment(scope, "reference scope")}`,
  reference: (type: string, scope: string, key: string): Key => ({ pk: keys.referencePartition(type, scope), sk: segment(key, "reference key") }),
};

/** The attributes of `WorldIndex` for an item of a world (docs/architecture.md §10). */
export function worldIndexAttributes(worldId: string, key: Key): Record<string, string> {
  return { worldIndexKey: worldPrefix(worldId), worldIndexSort: `${key.pk}|${key.sk}` };
}
