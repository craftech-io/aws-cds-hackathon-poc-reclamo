// The evidence of a case as labelled rows a person reads (docs/design-brief.md §9 "Caso"): the
// settlement line with its own renderer (result, network, settlement date, amount, customer, loan and
// instalment, operation code), and every other kind through Spanish field labels, amounts in pesos,
// instants in simulated time and enum values in words. Internal ids (the reading behind a
// reconciliation), hashes and the list of files reviewed never reach the screen.
import { formatPesos, formatSimInstant } from "@reclamo/shared";
import { NETWORK_LABEL } from "../../copy/console-labels";
import { complaintCopy } from "./copy";

export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
  /** A code or id, shown in a monospace face. */
  readonly code?: true;
}

const text = complaintCopy.evidence;
const MAX_ROWS = 14;
const MAX_VALUE = 160;

type Details = Readonly<Record<string, unknown>>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);
const obj = (value: unknown): Details | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Details) : undefined);

function instant(value: unknown): string | undefined {
  const raw = str(value);
  return raw && /^\d{4}-\d{2}-\d{2}T/.test(raw) && !Number.isNaN(Date.parse(raw)) ? formatSimInstant(raw) : undefined;
}

/** `2026-10-06` → `mar 06/10`. */
function businessDay(value: unknown): string | undefined {
  const raw = str(value);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? (formatSimInstant(`${raw}T12:00:00-03:00`).split(" ").slice(0, 2).join(" ")) : undefined;
}

function rows(entries: ReadonlyArray<readonly [string, string | undefined, boolean?]>): EvidenceRow[] {
  return entries.flatMap(([label, value, code]) => (value === undefined ? [] : [{ label, value, ...(code ? { code: true as const } : {}) }]));
}

/** The rows of a `SETTLEMENT_MATCH` (a settlement file's line, or a wallet or transfer movement). */
export function settlementRows(details: Details): EvidenceRow[] {
  const copy = text.settlement;
  const result = str(details["result"]) ?? "";
  const line = obj(details["line"]);
  const pending = obj(details["pending"]);
  const movement = obj(details["movement"]);
  const pendingAt = pending ? instant(pending["publishAtSim"]) : undefined;
  const resultText = result === "PENDING_BATCH" && pendingAt ? copy.pending(pendingAt) : copy.result[result];
  const network = str(line?.["network"]) ?? str(pending?.["network"]) ?? str(details["network"]);
  const loan = str(line?.["loanRef"]) ?? str(movement?.["loanId"]) ?? str(details["loanId"]);
  const instalment = num(line?.["instalment"]) ?? num(movement?.["instalment"]);
  const amount = num(line?.["amount"]) ?? num(movement?.["amount"]);
  return rows([
    [text.result, resultText],
    [copy.sourceLabel, copy.source[str(details["source"]) ?? ""]],
    [copy.network, network ? (NETWORK_LABEL[network] ?? network) : undefined],
    [copy.businessDate, businessDay(line?.["businessDate"] ?? pending?.["businessDate"])],
    [copy.paidAt, instant(line?.["paidAt"] ?? movement?.["atSim"])],
    [copy.amount, amount === undefined ? undefined : formatPesos(amount)],
    [copy.customer, str(line?.["customerRef"]), true],
    [copy.loanAndInstalment, loan && instalment !== undefined ? copy.instalment(loan, instalment) : undefined, true],
    [copy.loan, loan && instalment === undefined ? loan : undefined, true],
    [copy.operationCode, str(line?.["operationCode"]) ?? str(details["operationCode"]), true],
    [copy.movement, str(details["movementId"]) ?? str(movement?.["operationId"]), true],
    [copy.appliedAt, instant(details["appliedAtSim"])],
  ]);
}

const MONEY_FIELDS: ReadonlySet<string> = new Set(["amount", "charged", "expectedAmount", "gross", "originationFee", "net", "outstandingCents", "totalCents", "principalCents", "accruedInterestCents", "feeCents"]);
const CODE_FIELDS: ReadonlySet<string> = new Set(["chargeId", "loanId", "transferId", "operationId", "traceId", "duplicateDebitId", "quoteId", "feeCode", "feeClauseId"]);

function clipped(value: string): string {
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
}

function scalarText(field: string, value: unknown): string | undefined {
  if (typeof value === "number") return MONEY_FIELDS.has(field) && Number.isSafeInteger(value) ? formatPesos(value) : String(value);
  if (typeof value === "boolean") return value ? text.yes : text.no;
  if (typeof value === "string") return instant(value) ?? text.value[value] ?? value;
  return undefined;
}

function fieldText(field: string, value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      const fields = obj(item);
      if (!fields) return scalarText(field, item) ?? [];
      const parts = Object.entries(fields).flatMap(([key, part]) => (/sha256|hash|Id$/i.test(key) ? [] : (scalarText(key, part) ?? [])));
      return parts.length === 0 ? [] : [parts.join(" · ")];
    });
    return items.length === 0 ? undefined : clipped(items.join("; "));
  }
  const scalar = scalarText(field, value);
  return scalar === undefined ? undefined : clipped(scalar);
}

/** The labelled rows of any evidence but the receipt image and its reading (at most 14). */
export function evidenceRows(kind: string, details: Details): EvidenceRow[] {
  if (kind === "SETTLEMENT_MATCH") return settlementRows(details);
  const out: EvidenceRow[] = [];
  for (const [field, value] of Object.entries(details)) {
    const label = text.field[field];
    const shown = label === undefined ? undefined : fieldText(field, value);
    if (label !== undefined && shown !== undefined) out.push({ label, value: shown, ...(CODE_FIELDS.has(field) ? { code: true as const } : {}) });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}
