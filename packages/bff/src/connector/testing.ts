// Test helpers of the connector: a memory connector on a fixed real clock and minimal valid entities
// of every table, so tests of the connector (and of the modules built on it) start from rows that
// pass their schemas and change only what they test.
import type { z } from "zod";
import type { Approval, Evidence } from "../domain/case-items";
import type { Complaint } from "../domain/complaint";
import type { ConversationMeta, EmailRecord, Message } from "../domain/conversation";
import type { AuditEntry, RegisterEntry, TapeEntry } from "../domain/ledger";
import type { Timer } from "../domain/timer";
import type { Staff, WorldMeta, WorldSettings } from "../domain/world";
import type { NewOf } from "./codec";
import { type MemoryConnector, createMemoryConnector } from "./memory/connector";
import type { MemoryStoreOptions } from "./memory/engine";

/** Real "now" of every connector test (stamps and TTLs). */
export const TEST_NOW = new Date("2026-10-07T13:10:00.000Z");
/** Simulated "now" of the demo world at the start of the story (07/10 10:10 in Argentina). */
export const SIM_NOW = "2026-10-07T10:10:00-03:00";

export function testConnector(options: MemoryStoreOptions & { now?: () => Date } = {}): MemoryConnector {
  return createMemoryConnector({ now: () => new Date(TEST_NOW.getTime()), ...options });
}

type New<S extends z.ZodType> = NewOf<S>;

export function worldMeta(worldId: string, overrides: Partial<New<typeof WorldMeta>> = {}): New<typeof WorldMeta> {
  const kind = worldId === "demo" ? "DEMO" : worldId.startsWith("qa") ? "QA" : worldId.startsWith("sim-") ? "SIM" : "GUEST";
  return { worldId, kind, template: kind === "DEMO" ? "demo" : kind === "GUEST" ? "guest" : "models", epoch: 1, status: "REGISTERED", ...overrides } as New<typeof WorldMeta>;
}

export function worldSettings(worldId: string): New<typeof WorldSettings> {
  const caps = { agentCents: 25_000_000, operatorCents: 100_000_000 };
  return {
    worldId,
    caps: { perAction: { APPLY_PAYMENT: caps, REVERSE_CHARGE: caps, REFUND_DUPLICATE: caps, TRANSFER_REVERSAL: caps }, autoActionsPer30Days: 2 },
    contactHours: { weekday: { from: "08:00", to: "20:00" }, saturday: { from: "09:00", to: "13:00" }, formalNotice: { from: "09:00", to: "18:00" } },
    maxProactivePerDay: 3,
    settlementDelays: { NORTE: { businessDays: 1, publishAt: "08:30", cutoff: "18:00" } },
    turnCaps: { perHour: 200, perDay: 1_000 },
    imageReadsPerDay: 60,
    rateLimitPerHour: 20,
    channelModes: { whatsapp: "simulated" },
    manualBaseline: { items: [{ action: "ANSWER", minutes: 12, label: "supuesto" }] },
    referenceRate: { annualRate: 0.9, label: "supuesto" },
  };
}

export function staff(worldId: string, staffId = "stf-operator", sub = "0000-sub-operator"): New<typeof Staff> {
  return { worldId, staffId, role: "OPERATOR", displayName: "Operator", cognitoSubKey: `SUB#${sub}`, active: true };
}

export function complaint(worldId: string, overrides: Partial<New<typeof Complaint>> = {}): New<typeof Complaint> {
  return {
    worldId,
    complaintId: "cmp-0001",
    complaintNumber: "R-2026-000123",
    epoch: 1,
    customerId: "cus-0001",
    kind: "RECLAMO",
    type: "PAYMENT_NOT_REFLECTED",
    status: "REGISTERED",
    priority: "NORMAL",
    origin: "LIVE",
    control: "AGENT",
    channel: "WHATSAPP",
    summary: "Pago de la cuota 4 no reflejado",
    filedAtSim: SIM_NOW,
    deadlineSim: "2026-10-22T23:59:59-03:00",
    slaState: "ON_TIME",
    emailAnswerConsent: { status: "PENDING" },
    statusHistory: [{ from: null, to: "REGISTERED", atSim: SIM_NOW, cause: "FILED", actor: "SYSTEM" }],
    ...overrides,
  };
}

export function evidence(worldId: string, overrides: Partial<New<typeof Evidence>> = {}): New<typeof Evidence> {
  return { worldId, complaintId: "cmp-0001", evidenceId: "evd-0001", kind: "RECEIPT_READING", atSim: SIM_NOW, actor: "AGENT", details: { result: "READ" }, ...overrides };
}

export function approval(worldId: string, overrides: Partial<New<typeof Approval>> = {}): New<typeof Approval> {
  return {
    worldId,
    complaintId: "cmp-0001",
    approvalId: "apr-0001",
    action: "APPLY_PAYMENT",
    amountCents: 30_000_000,
    capTier: "OPERATOR",
    evidenceId: "evd-0001",
    justification: "Above the agent cap",
    requestedBy: "AGENT",
    requestedAtSim: SIM_NOW,
    decision: "PENDING",
    epoch: 1,
    expiresAtSim: "2026-10-09T10:10:00-03:00",
    ...overrides,
  };
}

export function timer(worldId: string, overrides: Partial<New<typeof Timer>> = {}): New<typeof Timer> {
  return { worldId, kind: "SLA", timerId: "cmp-0001-DEADLINE", dueAtSim: "2026-10-22T23:59:59-03:00", seq: 0, status: "SCHEDULED", epoch: 1, ownerKey: "CMP#cmp-0001", payload: {}, ...overrides };
}

export function conversation(worldId: string, overrides: Partial<New<typeof ConversationMeta>> = {}): New<typeof ConversationMeta> {
  return { worldId, customerId: "cus-0001", control: "AGENT", controlHistory: [], sessionEpoch: 1, disclosedEpochs: [], openComplaintIds: [], ...overrides };
}

export function message(worldId: string, overrides: Partial<New<typeof Message>> = {}): New<typeof Message> {
  return { worldId, customerId: "cus-0001", messageId: "msg-0001", direction: "IN", channel: "WHATSAPP", body: "Pagué la cuota 4", status: "RECEIVED", simulated: true, atSim: SIM_NOW, ...overrides };
}

export function email(worldId: string, overrides: Partial<New<typeof EmailRecord>> = {}): New<typeof EmailRecord> {
  return {
    worldId,
    customerId: "cus-0001",
    mailId: "mail-0001",
    kind: "ACK_EMAIL",
    toMasked: "s***@simulator.amazonses.com",
    subject: "Acuse de recibo",
    s3RawKey: "W/demo/2026-10-07/mail-0001.eml",
    attachments: [],
    events: [],
    sentAtSim: SIM_NOW,
    ...overrides,
  };
}

const HASH = (n: number) => n.toString(16).padStart(64, "0");

/** A register entry that follows a head of `seq − 1` built with these same helpers. */
export function registerEntry(worldId: string, seq: number, overrides: Partial<New<typeof RegisterEntry>> = {}): New<typeof RegisterEntry> {
  return {
    worldId,
    epoch: 1,
    seq,
    prevHash: HASH(seq - 1),
    hash: HASH(seq),
    atSim: SIM_NOW,
    atReal: TEST_NOW.toISOString(),
    eventType: seq === 1 ? "FILED" : "STATUS",
    complaintId: "cmp-0001",
    complaintNumber: "R-2026-000123",
    kind: "RECLAMO",
    type: "PAYMENT_NOT_REFLECTED",
    channel: "WHATSAPP",
    origin: "LIVE",
    ...overrides,
  };
}

export function tapeEntry(worldId: string, seq: number, overrides: Partial<New<typeof TapeEntry>> = {}): New<typeof TapeEntry> {
  return {
    worldId,
    epoch: 1,
    seq,
    prevHash: HASH(seq - 1),
    hash: HASH(seq),
    atSim: SIM_NOW,
    atReal: TEST_NOW.toISOString(),
    tapeId: `tape-${seq}`,
    decision: "ALLOWED",
    ruleIds: [],
    evaluated: [{ ruleId: "CH-WA-NO-COLLECTION", result: "PASS" }],
    ruleSetVersion: "v1",
    sender: "AGENT",
    channel: "WHATSAPP",
    kind: "REPLY",
    messageId: `msg-${seq}`,
    complaintId: "cmp-0001",
    ...overrides,
  };
}

export function auditEntry(worldId: string, overrides: Partial<New<typeof AuditEntry>> = {}): New<typeof AuditEntry> {
  return { worldId, epoch: 1, auditId: "aud-0001", ts: TEST_NOW.toISOString(), action: "COMPLAINT_REGISTERED", actor: "SYSTEM", refs: { complaintId: "cmp-0001" }, primaryRef: "CMP#cmp-0001", ...overrides };
}

/** The hash helper the entries above use, for building heads in tests. */
export function testHash(n: number): string {
  return HASH(n);
}
