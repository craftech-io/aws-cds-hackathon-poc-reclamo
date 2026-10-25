// Assembles the world templates (docs/seed-spec.md §4): every item with its definitive key relative
// to the world (`W#<worldId>#…`, docs/architecture.md §5) for `demo`, `guest` and `qa-min`, and the
// `models` file with each persona as a model `world.create` clones plus what every clone shares.
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import { EPOCH_PLACEHOLDER, START_AT_SIM, WORLD_PLACEHOLDER } from "../lib/constants";
import type { ModelsTemplateFile, ReceiptRef, SettlementFileRef, TemplateItem, WorldTemplateFile } from "../lib/template";
import { utcOf } from "./calendar";
import type { ConversationBundle } from "./conversations";
import { coreItems, item, networkItems } from "./core-rows";
import type { HistoryBundle, Json } from "./history";
import { timer } from "./history";
import type { MoneyHistory } from "./history-money";
import type { Ledger } from "./ledger";
import type { ReceiptFile } from "./receipt-catalog";
import { type Batch, batchPath } from "./settlements";
import { baseSettings, guestSettingsByOrigin } from "./settings";

const seeded = { worldId: WORLD_PLACEHOLDER, synthetic: true as const };
const EPOCH = `e${EPOCH_PLACEHOLDER}`;

export interface TemplateParts {
  readonly ledger: Ledger;
  readonly batches: readonly Batch[];
  readonly history: HistoryBundle;
  readonly money: MoneyHistory;
  readonly conversations: ConversationBundle;
  readonly receipts: readonly ReceiptFile[];
  readonly personaIds: readonly string[];
}

export function personaCustomerId(personaId: string): string {
  return `cus-${personaId.slice(1).padStart(4, "0")}`;
}

function sortSeq(seq: number): string {
  return String(seq).padStart(9, "0");
}

/** The timers of the template: batch publications, scheduled network transitions, SLA milestones and automatic closings. */
function templateTimers(parts: TemplateParts): Json[] {
  const timers: Json[] = [];
  for (const batch of parts.batches.filter((candidate) => candidate.status === "PENDING")) {
    timers.push(timer("SETTLEMENT_PUBLISH", `${batch.network}-${batch.businessDate}`, batch.publishAt, `BATCH#${batch.network}#${batch.businessDate}`, { network: batch.network, businessDate: batch.businessDate }));
  }
  const customers = new Set(parts.ledger.customers.map((customer) => customer.customerId));
  for (const transfer of parts.ledger.transfers.filter((candidate) => candidate.status === "PENDING" && candidate.expectedBy && customers.has(candidate.customerId))) {
    timers.push(timer("NETWORK_TRANSITION", transfer.transferId, transfer.expectedBy ?? "", `TRF#${transfer.transferId}`, { transferId: transfer.transferId, to: "COMPLETED" }));
  }
  for (const loan of parts.ledger.loans.filter((candidate) => candidate.disbursement.status === "PENDING" && candidate.disbursement.expectedBy && customers.has(candidate.customerId))) {
    timers.push(timer("NETWORK_TRANSITION", `dsb-${loan.loanId.slice(2)}`, loan.disbursement.expectedBy ?? "", `LOAN#${loan.loanId}`, { loanId: loan.loanId, to: "CREDITED" }));
  }
  timers.push(...parts.history.timers);
  return timers
    .sort((a, b) => Date.parse(String(a.dueAtSim)) - Date.parse(String(b.dueAtSim)) || (String(a.timerId) < String(b.timerId) ? -1 : 1))
    .map((entry, seq) => ({ ...entry, seq }));
}

function complaintItems(parts: TemplateParts, onlyCustomers?: ReadonlySet<string>): TemplateItem[] {
  const items: TemplateItem[] = [];
  const keep = (complaintId: unknown): boolean => !onlyCustomers || parts.history.complaints.some((complaint) => complaint.complaintId === complaintId && onlyCustomers.has(complaint.plan.customerId));
  for (const complaint of parts.history.complaints.filter((candidate) => keep(candidate.complaintId))) items.push(item("Complaints", `CMP#${complaint.complaintId}`, "META", "Complaint", complaint.meta));
  for (const evidence of parts.history.evidence.filter((entry) => keep(entry.complaintId))) items.push(item("Complaints", `CMP#${String(evidence.complaintId)}`, `EVD#${String(evidence.evidenceId)}`, "Evidence", evidence));
  for (const action of parts.money.actions.filter((entry) => keep(entry.complaintId))) items.push(item("Complaints", `CMP#${String(action.complaintId)}`, `ACT#${String(action.actionId)}`, "Action", action));
  for (const approval of parts.money.approvals.filter((entry) => keep(entry.complaintId))) items.push(item("Complaints", `CMP#${String(approval.complaintId)}`, `APR#${String(approval.approvalId)}`, "Approval", approval));
  return items;
}

function moneyCoreItems(parts: TemplateParts, customers: ReadonlySet<string>): TemplateItem[] {
  const items: TemplateItem[] = [];
  for (const { claimKey, ...claim } of parts.money.claims.filter((entry) => customers.has(String(entry.customerId)))) items.push(item("Core", String(claimKey), "CLAIM", "ActionClaim", { ...claim, synthetic: true }));
  for (const note of parts.money.creditNotes.filter((entry) => customers.has(String(entry.customerId)))) items.push(item("Core", `CUS#${String(note.customerId)}`, `CN#${String(note.creditNoteId)}`, "CreditNote", { ...note, synthetic: true }));
  return items;
}

function conversationItems(conversations: ConversationBundle, customers?: ReadonlySet<string>): TemplateItem[] {
  const mine = (entry: Json): boolean => !customers || customers.has(String(entry.customerId));
  return [
    ...conversations.metas.filter(mine).map((meta) => item("Conversations", `CONV#${String(meta.customerId)}`, "META", "ConversationMeta", meta)),
    ...conversations.messages.filter(mine).map((message) => item("Conversations", `CONV#${String(message.customerId)}`, `MSG#${utcOf(String(message.atSim))}#${String(message.messageId)}`, "Message", message)),
  ];
}

function appendOnlyItems(parts: TemplateParts): TemplateItem[] {
  const register = parts.history.register.map((entry) => item("Register", `REG#${EPOCH}`, sortSeq(Number(entry.seq)), "RegisterEntry", entry));
  const refunds = parts.money.refunds.map((entry) => item("Register", `RRI#${EPOCH}`, sortSeq(Number(entry.seq)), "RefundEntry", entry));
  const tape = parts.conversations.tape.map((entry) => item("ComplianceTape", `TAPE#${String(entry.atSim).slice(0, 10)}`, `${utcOf(String(entry.atSim))}#${String(entry.tapeId)}`, "TapeEntry", entry));
  const audit = parts.money.audit.map((entry) => item("AuditLog", `AUD#${EPOCH}#${String(entry.ts).slice(0, 7)}`, `${String(entry.ts)}#${String(entry.auditId)}`, "AuditEntry", entry));
  return [...register, ...refunds, ...tape, ...audit];
}

function head(entries: readonly Json[]): Json {
  const last = entries.at(-1);
  return { value: entries.length, hash: last ? String(last.hash) : "0".repeat(64), synthetic: true };
}

function runtimeItems(parts: TemplateParts): TemplateItem[] {
  return [
    item("Runtime", "CLOCK", "META", "StoredClock", { ...seeded, mode: "PAUSED", pausedSimNow: START_AT_SIM, worldEpoch: EPOCH_PLACEHOLDER, version: 1 }),
    item("Runtime", `COUNTER#CMP#${EPOCH}#2026`, "META", "Counter", { value: parts.history.complaints.length, synthetic: true }),
    item("Runtime", `COUNTER#REGSEQ#${EPOCH}`, "META", "ChainHead", head(parts.history.register)),
    item("Runtime", `COUNTER#RRISEQ#${EPOCH}`, "META", "ChainHead", head(parts.money.refunds)),
    item("Runtime", `COUNTER#TAPESEQ#${EPOCH}`, "META", "ChainHead", head(parts.conversations.tape)),
    item("Runtime", "WORLDSTATE", "META", "WorldState", { ...seeded, inFlight: [] }),
  ];
}

export function settlementRefs(batches: readonly Batch[]): SettlementFileRef[] {
  return batches.map((batch) => ({
    network: batch.network,
    businessDate: batch.businessDate,
    status: batch.status,
    publishAtSim: batch.publishAt,
    lineCount: batch.lines.length,
    ...(batch.status === "PUBLISHED" ? { seedPath: batchPath(batch.network, batch.businessDate), sha256: batch.sha256 ?? "" } : {}),
  }));
}

export function receiptRefs(receipts: readonly ReceiptFile[], personaIds: ReadonlySet<string>): ReceiptRef[] {
  return receipts
    .filter((receipt) => receipt.persona && personaIds.has(receipt.persona))
    .map((receipt) => ({ id: receipt.id, personaId: receipt.persona ?? "", variant: receipt.variant, seq: receipt.seq ?? 1, seedKey: `receipts/${receipt.path}`, sha256: receipt.sha256 }));
}

function personaRefs(personaIds: readonly string[]): WorldTemplateFile["personas"] {
  return personaIds.map((id) => {
    const script = PERSONA_SCRIPTS.find((candidate) => candidate.id === id);
    return { id, customerId: personaCustomerId(id), scenario: script?.scenario ?? "", flows: [...(script?.flows ?? [])] };
  });
}

export function buildTemplate(template: "demo" | "guest" | "qa-min", parts: TemplateParts): WorldTemplateFile {
  const customers = new Set(parts.ledger.customers.map((customer) => customer.customerId));
  const items: TemplateItem[] = [
    item("Worlds", "WORLD", "SETTINGS", "WorldSettings", baseSettings()),
    ...coreItems(parts.ledger, customers, template !== "demo"),
    ...moneyCoreItems(parts, customers),
    ...networkItems(parts.batches),
    ...complaintItems(parts),
    ...templateTimers(parts).map((entry) => item("Timers", `TIMER#${String(entry.kind)}#${String(entry.timerId)}`, "META", "Timer", entry)),
    ...conversationItems(parts.conversations),
    ...appendOnlyItems(parts),
    ...runtimeItems(parts),
  ];
  const counts: Record<string, number> = {};
  for (const entry of items) counts[entry.entity] = (counts[entry.entity] ?? 0) + 1;
  return {
    format: "reclamo-seed-template/1",
    template,
    startAtSim: START_AT_SIM,
    placeholders: { worldId: WORLD_PLACEHOLDER, epoch: EPOCH_PLACEHOLDER },
    settings: baseSettings(),
    ...(template === "guest" ? { settingsByOrigin: guestSettingsByOrigin() } : {}),
    personas: personaRefs(parts.personaIds),
    receipts: receiptRefs(parts.receipts, new Set(parts.personaIds)),
    settlements: settlementRefs(parts.batches),
    counts,
    items,
  };
}

/** `models`: per persona, its books, complaints and register events (to append in the clone's own chain). */
export function buildModels(parts: TemplateParts): ModelsTemplateFile {
  const personaCustomers = new Set(parts.personaIds.map(personaCustomerId));
  const payers = new Set(parts.ledger.customers.map((customer) => customer.customerId).filter((id) => !personaCustomers.has(id)));
  const allTimers = templateTimers(parts);
  const personas: ModelsTemplateFile["personas"] = {};
  for (const personaId of parts.personaIds) {
    const customerId = personaCustomerId(personaId);
    const only = new Set([customerId]);
    const ownTimers = allTimers.filter((entry) => {
      const payload = entry.payload as Json;
      return parts.ledger.transfers.some((transfer) => transfer.transferId === payload.transferId && transfer.customerId === customerId) || parts.ledger.loans.some((loan) => loan.loanId === payload.loanId && loan.customerId === customerId);
    });
    const complaintIds = new Set(parts.history.complaints.filter((complaint) => complaint.plan.customerId === customerId).map((complaint) => complaint.complaintId));
    personas[personaId] = {
      persona: personaRefs([personaId])[0] ?? { id: personaId, customerId, scenario: "", flows: [] },
      receipts: receiptRefs(parts.receipts, new Set([personaId])),
      items: [
        ...coreItems(parts.ledger, only, true),
        ...moneyCoreItems(parts, only),
        ...complaintItems(parts, only),
        ...ownTimers.map((entry) => item("Timers", `TIMER#${String(entry.kind)}#${String(entry.timerId)}`, "META", "Timer", entry)),
        ...conversationItems(parts.conversations, only),
      ],
      registerEvents: parts.history.register.filter((entry) => complaintIds.has(String(entry.complaintId))).map(({ seq: _seq, prevHash: _prev, hash: _hash, ...entry }) => entry),
    };
  }
  return {
    format: "reclamo-seed-template/1",
    template: "models",
    startAtSim: START_AT_SIM,
    placeholders: { worldId: WORLD_PLACEHOLDER, epoch: EPOCH_PLACEHOLDER },
    settings: baseSettings(),
    settlements: settlementRefs(parts.batches),
    shared: [
      ...coreItems(parts.ledger, payers, true),
      ...networkItems(parts.batches),
      ...allTimers.filter((entry) => entry.kind === "SETTLEMENT_PUBLISH").map((entry) => item("Timers", `TIMER#${String(entry.kind)}#${String(entry.timerId)}`, "META", "Timer", entry)),
      item("Runtime", "CLOCK", "META", "StoredClock", { ...seeded, mode: "PAUSED", pausedSimNow: START_AT_SIM, worldEpoch: EPOCH_PLACEHOLDER, version: 1 }),
    ],
    personas,
  };
}
