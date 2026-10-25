// `POST /customers/{customerId}/challenge-check`: the identity challenge compared by code with the
// core's rows (docs/design-brief.md §5, step 3). The answer is `{ok}` and nothing else: the expected
// value never leaves the core, not even in an error. Attempts are counted by `ToolIdentity`.
//
//   LAST_DUE_DATE           due date of the last instalment already due ("5/10", "05-10-2026",
//                           "5 de octubre", "2026-10-05")
//   LAST_INSTALMENT_AMOUNT  amount of that instalment ("118640", "$ 118.640,00", "118.640")
//   LAST_MOVEMENT_AMOUNT    amount of the last wallet operation (customers without loans)
//
// A kind the customer cannot answer (no instalment due yet, no operation) is `NOT_ELIGIBLE`, so the
// tool asks another kind instead of counting a failure.
import type { ChallengeCheckRequest, ChallengeCheckResult } from "@reclamo/core-contract";
import { type CustomerBundle, loadCustomer } from "./bundle";
import { type LedgerContext, LedgerError, instantMs, localDate } from "./context";

const MONTHS: Readonly<Record<string, number>> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, set: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};

export interface DayMonth {
  readonly day: number;
  readonly month: number;
  readonly year?: number;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function validDay(day: number, month: number): boolean {
  return Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function fullYear(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const year = Number(raw);
  return raw.length === 2 ? 2000 + year : year;
}

/** Day, month and maybe year of a date as a customer writes it; `undefined` when it is not one. */
export function parseDateAnswer(answer: string): DayMonth | undefined {
  const text = fold(answer);
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) {
    const [, year, month, day] = iso.map(Number);
    return validDay(day ?? 0, month ?? 0) ? { day: day ?? 0, month: month ?? 0, year: year ?? 0 } : undefined;
  }
  const numeric = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2}|\d{4}))?(?!\d)/.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = fullYear(numeric[3]);
    return validDay(day, month) ? { day, month, ...(year === undefined ? {} : { year }) } : undefined;
  }
  const words = /(\d{1,2})\s*(?:de\s+)?([a-z]+)\.?(?:\s*(?:de|del)?\s*(\d{4}))?/.exec(text);
  if (words) {
    const day = Number(words[1]);
    const month = MONTHS[words[2] ?? ""];
    const year = fullYear(words[3]);
    return month !== undefined && validDay(day, month) ? { day, month, ...(year === undefined ? {} : { year }) } : undefined;
  }
  return undefined;
}

/** Integer centavos of an amount as a customer writes it (es-AR: `.` thousands, `,` decimals); whether it had decimals. */
export function parseAmountAnswer(answer: string): { readonly cents: number; readonly withDecimals: boolean } | undefined {
  const match = /\d[\d.,\s]*/.exec(answer.replace(/\$/g, " "));
  if (!match) return undefined;
  let digits = match[0].replace(/\s+/g, "").replace(/[.,]$/, "");
  let decimals = "";
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  const separator = Math.max(lastComma, lastDot);
  if (separator >= 0) {
    const tail = digits.slice(separator + 1);
    const both = lastComma >= 0 && lastDot >= 0;
    if (both || tail.length === 1 || tail.length === 2) {
      decimals = tail.padEnd(2, "0");
      digits = digits.slice(0, separator);
    }
  }
  const whole = digits.replace(/[.,]/g, "");
  if (!/^\d{1,12}$/.test(whole)) return undefined;
  return { cents: Number(whole) * 100 + Number(decimals === "" ? "0" : decimals), withDecimals: decimals !== "" };
}

/** An amount answer matches to the centavo, or to the peso when the customer left the decimals out. */
export function amountMatches(answer: string, expected: number): boolean {
  const parsed = parseAmountAnswer(answer);
  if (parsed === undefined) return false;
  if (parsed.cents === expected) return true;
  return !parsed.withDecimals && parsed.cents === Math.floor(expected / 100) * 100;
}

export function dateMatches(answer: string, expected: string): boolean {
  const parsed = parseDateAnswer(answer);
  if (parsed === undefined) return false;
  const [year, month, day] = expected.split("-").map(Number);
  return parsed.day === day && parsed.month === month && (parsed.year === undefined || parsed.year === year);
}

/** Pure: the instalments already due, latest due date first. */
function lastDueInstalments(bundle: CustomerBundle, today: string): Array<{ dueDate: string; amount: number }> {
  return [...bundle.loans.values()]
    .flatMap((state) => state.instalments.map((instalment) => instalment.value))
    .filter((instalment) => instalment.dueDate <= today)
    .sort((a, b) => (a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0));
}

export async function checkChallenge(ctx: LedgerContext, customerId: string, request: ChallengeCheckRequest): Promise<ChallengeCheckResult> {
  const bundle = await loadCustomer(ctx, customerId);
  const today = localDate(ctx.simNow);
  switch (request.kind) {
    case "LAST_DUE_DATE": {
      const last = lastDueInstalments(bundle, today)[0];
      if (last === undefined) throw new LedgerError("NOT_ELIGIBLE", "no instalment is due yet");
      return { ok: dateMatches(request.answer, last.dueDate) };
    }
    case "LAST_INSTALMENT_AMOUNT": {
      const due = lastDueInstalments(bundle, today);
      const latest = due[0];
      if (latest === undefined) throw new LedgerError("NOT_ELIGIBLE", "no instalment is due yet");
      // Two loans can fall due on the same day: either amount is a right answer.
      return { ok: due.filter((instalment) => instalment.dueDate === latest.dueDate).some((instalment) => amountMatches(request.answer, instalment.amount)) };
    }
    case "LAST_MOVEMENT_AMOUNT": {
      const nowMs = instantMs(ctx.simNow);
      const last = [...bundle.movements].reverse().find((movement) => instantMs(movement.value.atSim) <= nowMs);
      if (last === undefined) throw new LedgerError("NOT_ELIGIBLE", "the wallet has no operations");
      return { ok: amountMatches(request.answer, last.value.amount) };
    }
  }
}
