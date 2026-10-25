// Reference implementations of the decisions invariants 8 to 11 check (docs/seed-spec.md §14), written
// from the contracts: `check_charge` against the fee schedule (docs/seed-spec.md §3), the duplicate
// debit rule (same instalment, same amount, within 72 h; docs/design-brief.md §4) and the channel
// policy rules a historical reply must pass (docs/design-brief.md §7). They run only while the real
// modules (real-logic.ts) do not exist or do not load.
export type Json = Record<string, unknown>;

export interface ChargeContext {
  readonly charge: Json;
  readonly loans: ReadonlyMap<string, Json>;
  readonly instalments: ReadonlyMap<string, Json>;
  readonly payments: readonly Json[];
  readonly earlierSameFee: readonly Json[];
}

const DAY_MS = 86_400_000;

function origination(principal: number): number {
  const fee = Math.round(principal * 0.03);
  return fee + Math.round(fee * 0.21);
}

/** The verdict `check_charge` gives a charge, from the fee schedule only. */
export function checkCharge(context: ChargeContext): { verdict: "CORRECT" | "WRONG" | "UNDETERMINED"; reason: string; expectedAmount: number } {
  const { charge } = context;
  const amount = Number(charge.amount);
  switch (charge.feeCode) {
    case "FEE-INS":
      return { verdict: "WRONG", reason: "NOT_CHARGEABLE", expectedAmount: 0 };
    case "FEE-CARD-REPL": {
      if (charge.requested !== true) return { verdict: "WRONG", reason: "NOT_REQUESTED", expectedAmount: 0 };
      return amount === 250_000 ? { verdict: "CORRECT", reason: "MATCHES_SCHEDULE", expectedAmount: 250_000 } : { verdict: "WRONG", reason: "AMOUNT_DIFFERS", expectedAmount: 250_000 };
    }
    case "FEE-ORIG": {
      const loan = context.loans.get(String(charge.loanId));
      if (!loan) return { verdict: "UNDETERMINED", reason: "NO_RULE", expectedAmount: 0 };
      if (context.earlierSameFee.some((other) => other.loanId === charge.loanId)) return { verdict: "WRONG", reason: "DUPLICATED", expectedAmount: 0 };
      const expected = origination(Number(loan.principal));
      return { verdict: amount === expected ? "CORRECT" : "WRONG", reason: amount === expected ? "MATCHES_SCHEDULE" : "AMOUNT_DIFFERS", expectedAmount: expected };
    }
    case "FEE-PUNIT": {
      const loan = context.loans.get(String(charge.loanId));
      const instalment = context.instalments.get(`${String(charge.loanId)}#${String(charge.instalment)}`);
      const payment = context.payments.find((candidate) => candidate.loanId === charge.loanId && (candidate.allocations as Json[]).some((allocation) => allocation.instalment === charge.instalment));
      if (!loan || !instalment || !payment) return { verdict: "UNDETERMINED", reason: "NO_RULE", expectedAmount: 0 };
      const days = Math.round((Date.parse(`${String(payment.paidAtSim).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(instalment.dueDate)}T00:00:00Z`)) / DAY_MS);
      if (days <= 2) return { verdict: "WRONG", reason: "WITHIN_TOLERANCE", expectedAmount: 0 };
      const expected = Math.round(((Number(instalment.amount) * Number(loan.annualRate) * 0.5) / 365) * days);
      return { verdict: amount === expected ? "CORRECT" : "WRONG", reason: amount === expected ? "MATCHES_SCHEDULE" : "AMOUNT_DIFFERS", expectedAmount: expected };
    }
    default:
      return { verdict: "UNDETERMINED", reason: "NO_RULE", expectedAmount: 0 };
  }
}

/** Debits of a loan that duplicate an earlier one: same instalment, same amount, within 72 hours. */
export function duplicateDebits(debits: readonly Json[]): Json[] {
  const sorted = [...debits].sort((a, b) => Date.parse(String(a.atSim)) - Date.parse(String(b.atSim)));
  return sorted.filter((debit, index) =>
    sorted.slice(0, index).some((earlier) => earlier.instalment === debit.instalment && earlier.amount === debit.amount && Date.parse(String(debit.atSim)) - Date.parse(String(earlier.atSim)) <= 72 * 3_600_000),
  );
}

/** Collection wording the reference check refuses in a WhatsApp outbound (a subset of the real lexicon). */
const COLLECTION_PATTERNS = [
  /\bpag[aá](la|lo)?\s+(hoy|ya|ahora)\b/i,
  /\babon[aá]\b/i,
  /\bregulariz[aá]\b/i,
  /\bcancel[aá]\s+tu\s+deuda\b/i,
  /\bevit[aá]\s+recargos\b/i,
  /\binformaremos\b/i,
  /\bacciones\s+legales\b/i,
  /\bmora\b/i,
  /\bplan\s+de\s+pagos?\b/i,
  /\bquita\b/i,
  /\brefinanci/i,
  /\bdeuda\b/i,
];

export function looksLikeCollection(text: string): boolean {
  return COLLECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export interface PolicyContext {
  readonly message: Json;
  readonly inbound: readonly Json[];
  readonly customer: Json | undefined;
}

/** The rules a historical WhatsApp reply of the agent must pass at its own instant (contract of CH-*). */
export function replyAllowed(context: PolicyContext): { allowed: boolean; rule?: string } {
  const { message } = context;
  if (message.sender !== "AGENT" && !String(message.sender).startsWith("OPERATOR:") && message.sender !== "SYSTEM") return { allowed: false, rule: "CH-SENDER" };
  if (looksLikeCollection(String(message.body))) return { allowed: false, rule: "CH-WA-NO-COLLECTION" };
  const at = Date.parse(String(message.atSim));
  const lastIn = context.inbound.filter((entry) => Date.parse(String(entry.atSim)) <= at).sort((a, b) => Date.parse(String(b.atSim)) - Date.parse(String(a.atSim)))[0];
  if (!lastIn) return { allowed: false, rule: "CH-WA-CUSTOMER-INITIATED" };
  if (at - Date.parse(String(lastIn.atSim)) > 24 * 3_600_000) return { allowed: false, rule: "CH-WA-24H" };
  const optOut = context.customer?.optOut as Json | undefined;
  if (optOut?.optedOut === true) return { allowed: false, rule: "CH-OPTOUT" };
  return { allowed: true };
}
