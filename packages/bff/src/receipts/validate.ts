// Validation of what a receipt says (docs/architecture-integrations.md §7, step 3; FL-020): the
// operation code has the network's format and a valid check digit (Luhn over its 14 digits), its
// prefix agrees with the network, the payment is in the past of the WORLD's clock, and the amount is
// positive and at most $ 5.000.000. Whatever Bedrock or the chunk read is checked here the same way:
// nothing read becomes a field without passing these rules. Fields are never logged. The payer
// reference is printed text of a hostile image: it is masked (lib/mask.ts, and any long digit run the
// patterns left) before it becomes a field, so no DNI, CUIT, CBU, card, phone or email is ever kept.
import { maskSensitive } from "../lib/mask";
import { type RawReading, MAX_RECEIPT_CENTS, PAID_AT_LOCAL, type ReadingProblem, type ReceiptFields, ReceiptNetwork } from "./schema";

/** Prefix of the operation code of each network that issues one (a wallet payment is `BIL`). */
export const CODE_PREFIX: Readonly<Partial<Record<ReceiptNetwork, string>>> = { NORTE: "NTE", SUR: "SUR", WALLET: "BIL" };

const OPERATION_CODE = /^(NTE|SUR|BIL)-(\d{8})-(\d{6})-(\d)$/;
const AR_OFFSET = "-03:00";

/** Luhn check digit of a string of digits. */
export function luhnDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new RangeError("digits only");
  // From the right: every other digit doubled (and its digits summed), starting with the last one.
  const sum = [...digits].reverse().reduce((total, char, index) => {
    const value = Number(char) * (index % 2 === 0 ? 2 : 1);
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return (10 - (sum % 10)) % 10;
}

export type CodeCheck = { readonly ok: true; readonly prefix: string; readonly date: string } | { readonly ok: false; readonly problem: "INVALID_FORMAT" | "INVALID_CHECK_DIGIT" };

/** Format and check digit of an operation code (`NTE-20261006-004817-7`). */
export function checkOperationCode(code: string): CodeCheck {
  const match = OPERATION_CODE.exec(code);
  if (!match) return { ok: false, problem: "INVALID_FORMAT" };
  const [, prefix = "", date = "", serial = "", digit = ""] = match;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const noon = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(noon.getTime()) || noon.toISOString().slice(0, 10) !== iso) return { ok: false, problem: "INVALID_FORMAT" };
  if (luhnDigit(date + serial) !== Number(digit)) return { ok: false, problem: "INVALID_CHECK_DIGIT" };
  return { ok: true, prefix, date: iso };
}

/** The instant of a printed local time in Argentina (no DST: always UTC−03:00). */
export function paidAtInstant(paidAtLocal: string): Date | undefined {
  const match = PAID_AT_LOCAL.exec(paidAtLocal);
  if (!match) return undefined;
  const instant = new Date(`${match[1] ?? ""}T${match[2] ?? ""}:${match[3] ?? ""}:00${AR_OFFSET}`);
  if (Number.isNaN(instant.getTime())) return undefined;
  // Reject impossible dates that Date would roll over (2026-02-30).
  const local = new Date(instant.getTime() - 3 * 3_600_000).toISOString().slice(0, 16);
  return local === paidAtLocal ? instant : undefined;
}

/** "118640.00" or 118640 (pesos) → 11864000 centavos; undefined for anything else. */
export function pesosToCents(amount: number | string): number | undefined {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const cents = Math.round(amount * 100);
    return Math.abs(cents - amount * 100) < 1e-6 ? cents : undefined;
  }
  const match = /^(\d{1,9})\.(\d{2})$/.exec(amount);
  return match ? Number(match[1]) * 100 + Number(match[2]) : undefined;
}

/** Six digits or more, grouped or not, that no mask pattern took (a number cut at 64 characters). */
const LEFTOVER_DIGITS = /\d(?:[ .-]?\d){5,}/g;
/** What stands for a masked leftover number in the payer reference. */
export const PAYER_NUMBER_MASK = "[NRO]";
const MAX_PAYER_REFERENCE = 64;

/** The printed payer reference as it may be kept: masked, trimmed, at most 64 characters; `undefined` when empty. */
export function safePayerReference(printed: string | undefined): string | undefined {
  if (printed === undefined) return undefined;
  const masked = maskSensitive(printed).replace(LEFTOVER_DIGITS, PAYER_NUMBER_MASK).trim().slice(0, MAX_PAYER_REFERENCE).trim();
  return masked === "" ? undefined : masked;
}

export interface CandidateFields {
  readonly network?: string;
  readonly operationCode?: string;
  /** Integer centavos. */
  readonly amount?: number;
  readonly paidAtLocal?: string;
  readonly payerReference?: string;
}

export type FieldsCheck = { readonly ok: true; readonly fields: ReceiptFields } | { readonly ok: false; readonly problem: Exclude<ReadingProblem, "INVALID_OUTPUT"> };

/**
 * The rules of step 3 on a candidate: missing code, amount or date is `INCOMPLETE` (never a
 * guess); everything else that fails is a receipt that cannot be (`INVALID_RECEIPT`).
 */
export function validateFields(candidate: CandidateFields, simNow: Date): FieldsCheck {
  const { operationCode, amount, paidAtLocal } = candidate;
  if (operationCode === undefined || operationCode === "" || amount === undefined || paidAtLocal === undefined || paidAtLocal === "") return { ok: false, problem: "INCOMPLETE" };
  const code = checkOperationCode(operationCode);
  if (!code.ok) return { ok: false, problem: code.problem };
  const declared = candidate.network === undefined || candidate.network === "" || candidate.network === "UNKNOWN" ? undefined : ReceiptNetwork.safeParse(candidate.network);
  if (declared !== undefined && !declared.success) return { ok: false, problem: "NETWORK_MISMATCH" };
  const network = declared?.data ?? networkOfPrefix(code.prefix);
  if (network === undefined || CODE_PREFIX[network] !== code.prefix) return { ok: false, problem: "NETWORK_MISMATCH" };
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_RECEIPT_CENTS) return { ok: false, problem: "AMOUNT_OUT_OF_RANGE" };
  const paidAt = paidAtInstant(paidAtLocal);
  if (paidAt === undefined) return { ok: false, problem: "INVALID_FORMAT" };
  if (paidAt.getTime() > simNow.getTime()) return { ok: false, problem: "FUTURE_DATE" };
  const payerReference = safePayerReference(candidate.payerReference);
  return {
    ok: true,
    fields: { network, operationCode, amount, paidAtLocal, ...(payerReference === undefined ? {} : { payerReference }) },
  };
}

function networkOfPrefix(prefix: string): ReceiptNetwork | undefined {
  return (Object.entries(CODE_PREFIX) as Array<[ReceiptNetwork, string]>).find(([, value]) => value === prefix)?.[0];
}

/** The candidate fields of Bedrock's answer (amount in pesos → centavos). */
export function candidateOf(raw: RawReading): CandidateFields {
  const payerReference = safePayerReference(raw.payerReference);
  const amount = raw.amount === undefined ? undefined : pesosToCents(raw.amount);
  return {
    ...(raw.network === undefined ? {} : { network: raw.network }),
    ...(raw.operationCode === undefined ? {} : { operationCode: raw.operationCode }),
    // A number Bedrock read that is not pesos with cents is not an amount: it fails as out of range.
    ...(raw.amount === undefined ? {} : { amount: amount ?? -1 }),
    ...(raw.paidAtLocal === undefined ? {} : { paidAtLocal: raw.paidAtLocal }),
    ...(payerReference === undefined ? {} : { payerReference }),
  };
}

/** A `PARTIAL` reading counts as `CLEAR` only with code, amount and date all present. */
export function isComplete(raw: RawReading): boolean {
  return Boolean(raw.operationCode) && raw.amount !== undefined && Boolean(raw.paidAtLocal);
}
