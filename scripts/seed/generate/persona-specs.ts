// The 41 personas of the phone simulator as data (docs/seed-spec.md §8): loans, the payments each
// scenario needs, charges, duplicate debits, transfers, disbursements and account states. Amounts are
// pesos here (the builder converts to centavos). Names, scenarios and scripts come from
// packages/bff/src/copy/persona-scripts.ts; this file only says what the core must hold for them.
import type { TransferRecord } from "./ledger";

export type PaymentNetwork = "NORTE" | "SUR" | "WALLET";

/** A payment the scenario needs, on top of the instalments paid by automatic debit. */
export interface PaymentSpec {
  readonly network: PaymentNetwork;
  readonly instalments: readonly number[];
  /** Local `YYYY-MM-DD HH:MM`. */
  readonly at: string;
  /** Pesos; default = the sum of the instalments. */
  readonly amount?: number;
  /** Applied by the core (an `OPC#` claim exists); otherwise the money is in a settlement or the wallet only. */
  readonly applied: boolean;
  /** Fixed sequence of the operation code (the flows quote some). */
  readonly seq?: number;
  readonly terminal?: string;
  /** Persona receipt rendered from this payment. */
  readonly receipt?: "legible" | "blurry" | "injection";
}

export interface LoanSpec {
  readonly suffix?: string;
  readonly principal: number;
  readonly count: number;
  /** Fixed instalment in pesos; otherwise derived from the default rate. */
  readonly instalment?: number;
  /** First due date. */
  readonly firstDue: string;
  /** Instalments 1..paidThrough are paid by automatic debit from the wallet on their due date. */
  readonly paidThrough: number;
  readonly payments?: readonly PaymentSpec[];
  /** A second debit of an instalment already debited (the seeded duplicates). */
  readonly duplicateDebit?: { readonly instalment: number; readonly at: string };
  /** Two different instalments debited the same day (the false duplicate). */
  readonly jointDebit?: { readonly instalments: readonly [number, number]; readonly at: string };
  /** Instalment paid late from the wallet, with the late-interest charge it caused. */
  readonly latePayment?: { readonly instalment: number; readonly days: number };
  readonly disbursement?: { readonly status: "CREDITED" | "PENDING" | "FAILED_RETURNED"; readonly at: string; readonly expectedBy?: string; readonly returnedAt?: string };
}

export interface ChargeSpec {
  readonly feeCode: "FEE-CARD-REPL" | "FEE-INS" | "FEE-ORIG";
  readonly amount?: number;
  readonly at: string;
  /** For FEE-CARD-REPL: the customer asked for the card (a `CardRequest` exists). */
  readonly requested?: boolean;
}

/** A transfer of the ledger (ledger.ts) as a spec: pesos and local `YYYY-MM-DD HH:MM` times. */
export type TransferSpec = Omit<TransferRecord, "transferId" | "customerId" | "counterpartyMasked">;

/** A receipt that is not the render of a real payment (fake codes, other payers, drawings). */
export interface ReceiptOnlySpec {
  readonly variant: "fake-check" | "fake-unknown" | "not-receipt" | "other-payer";
  /** Local `YYYY-MM-DD HH:MM` printed on a fake receipt. */
  readonly at?: string;
}

export interface PersonaSpec {
  readonly id: string;
  readonly loans: readonly LoanSpec[];
  readonly walletBalance: number;
  readonly optIn?: boolean;
  readonly bounce?: boolean;
  readonly blocked?: "IDENTITY_VALIDATION";
  readonly charges?: readonly ChargeSpec[];
  readonly transfers?: readonly TransferSpec[];
  readonly receipts?: readonly ReceiptOnlySpec[];
}

const L = (principal: number, count: number, firstDue: string, paidThrough: number, extra: Partial<LoanSpec> = {}): LoanSpec => ({ principal, count, firstDue, paidThrough, ...extra });

export const PERSONA_SPECS: readonly PersonaSpec[] = [
  { id: "C01", walletBalance: 12_400, loans: [L(960_000, 12, "2026-07-05", 3, { instalment: 118_640, payments: [{ network: "NORTE", instalments: [4], at: "2026-10-06 18:40", applied: false, seq: 4817, terminal: "T-0412", receipt: "legible" }] })] },
  { id: "C02", walletBalance: 31_800, loans: [L(300_000, 6, "2026-08-10", 2)], charges: [{ feeCode: "FEE-CARD-REPL", at: "2026-10-01 10:00", requested: false }] },
  {
    id: "C03",
    walletBalance: 48_000,
    loans: [L(1_184_000, 12, "2026-05-02", 6, { instalment: 146_300, duplicateDebit: { instalment: 6, at: "2026-10-03 07:00" } })],
  },
  { id: "C04", walletBalance: 9_300, loans: [L(480_000, 9, "2026-06-01", 4, { payments: [{ network: "SUR", instalments: [5], at: "2026-10-02 13:15", applied: false, receipt: "legible" }] })] },
  { id: "C05", walletBalance: 22_000, loans: [L(240_000, 6, "2026-04-15", 6)] },
  {
    id: "C06",
    walletBalance: 15_200,
    loans: [L(360_000, 12, "2026-08-20", 2)],
    transfers: [{ direction: "OUT", amount: 180_000, at: "2026-10-07 06:12", status: "COMPLETED", traceId: "TRZ-9M4D2X7P" }],
  },
  { id: "C07", walletBalance: 6_700, loans: [L(420_000, 12, "2026-07-03", 3)], receipts: [{ variant: "fake-check", at: "2026-10-05 16:20" }] },
  { id: "C08", walletBalance: 54_900, loans: [L(600_000, 18, "2026-03-15", 7)] },
  { id: "C09", walletBalance: 3_100, loans: [L(424_600, 9, "2026-07-25", 2, { instalment: 64_210 })] },
  { id: "C10", walletBalance: 18_500, loans: [L(200_000, 6, "2026-07-12", 3, { suffix: "a" }), L(150_000, 3, "2026-08-28", 2, { suffix: "b" })] },
  { id: "C11", walletBalance: 27_300, loans: [L(330_000, 6, "2026-07-01", 3, { payments: [{ network: "SUR", instalments: [4], at: "2026-10-02 10:30", applied: true, receipt: "legible" }] })] },
  {
    id: "C12",
    walletBalance: 4_800,
    loans: [L(707_000, 12, "2026-06-05", 4, { instalment: 87_400, payments: [{ network: "NORTE", instalments: [5], amount: 50_000, at: "2026-10-05 11:20", applied: false, receipt: "legible" }] })],
  },
  {
    id: "C13",
    walletBalance: 11_000,
    loans: [L(1_264_000, 12, "2026-05-05", 4, { instalment: 156_200, payments: [{ network: "NORTE", instalments: [5, 6], at: "2026-10-05 12:05", applied: false, receipt: "legible" }] })],
  },
  { id: "C14", walletBalance: 20_100, loans: [L(180_000, 6, "2026-05-05", 5, { payments: [{ network: "NORTE", instalments: [6], at: "2026-10-05 09:45", applied: false, receipt: "legible" }] })] },
  { id: "C15", walletBalance: 2_300, loans: [L(270_000, 6, "2026-06-05", 4, { payments: [{ network: "WALLET", instalments: [5], at: "2026-10-05 08:00", applied: false, receipt: "legible" }] })] },
  { id: "C16", walletBalance: 8_800, loans: [L(390_000, 9, "2026-07-01", 3, { payments: [{ network: "SUR", instalments: [4], at: "2026-10-01 12:00", applied: false, receipt: "blurry" }] })] },
  { id: "C17", walletBalance: 13_600, loans: [L(510_000, 12, "2026-06-05", 4, { payments: [{ network: "NORTE", instalments: [5], at: "2026-10-05 15:30", applied: false, receipt: "legible" }] })] },
  { id: "C18", walletBalance: 5_500, loans: [L(300_000, 6, "2026-07-05", 3)], receipts: [{ variant: "fake-unknown", at: "2026-10-05 13:10" }] },
  { id: "C19", walletBalance: 7_900, loans: [L(350_000, 9, "2026-07-01", 3, { payments: [{ network: "SUR", instalments: [4], at: "2026-10-01 14:00", applied: false, receipt: "injection" }] })] },
  { id: "C20", walletBalance: 10_400, loans: [L(200_000, 6, "2026-06-05", 4)], receipts: [{ variant: "not-receipt" }] },
  { id: "C21", walletBalance: 16_000, loans: [L(360_000, 6, "2026-07-20", 3)] },
  { id: "C22", walletBalance: 19_700, loans: [L(400_000, 9, "2026-07-10", 3, { latePayment: { instalment: 2, days: 5 } })] },
  { id: "C23", walletBalance: 61_200, loans: [L(500_000, 12, "2026-07-10", 3)], charges: [{ feeCode: "FEE-INS", amount: 38_900, at: "2026-10-01 10:05" }] },
  {
    id: "C24",
    walletBalance: 240_000,
    loans: [L(5_840_220.39, 18, "2026-09-15", 1, { disbursement: { status: "CREDITED", at: "2026-08-15 10:00" } })],
    charges: [{ feeCode: "FEE-ORIG", at: "2026-08-16 09:30" }],
  },
  { id: "C25", walletBalance: 35_400, loans: [L(585_000, 12, "2026-05-02", 6, { instalment: 72_300, duplicateDebit: { instalment: 6, at: "2026-10-04 07:00" } })] },
  { id: "C26", walletBalance: 14_900, loans: [L(560_000, 12, "2026-05-05", 4, { jointDebit: { instalments: [5, 6], at: "2026-10-05 07:00" } })] },
  {
    id: "C27",
    walletBalance: 28_000,
    loans: [L(250_000, 6, "2026-08-10", 2)],
    transfers: [{ direction: "OUT", amount: 45_000, at: "2026-10-05 14:20", status: "COMPLETED", traceId: "TRZ-7F3K9Q2M" }],
  },
  {
    id: "C28",
    walletBalance: 12_000,
    loans: [L(300_000, 6, "2026-08-10", 2)],
    transfers: [{ direction: "OUT", amount: 60_000, at: "2026-10-06 17:05", status: "PENDING", expectedBy: "2026-10-08 12:00" }],
  },
  {
    id: "C29",
    walletBalance: 33_000,
    loans: [L(280_000, 6, "2026-08-10", 2)],
    transfers: [{ direction: "OUT", amount: 25_000, at: "2026-10-02 11:40", status: "REJECTED_REVERSED", rejectReason: "CVU de destino inexistente", reversedAt: "2026-10-02 11:52" }],
  },
  {
    id: "C30",
    walletBalance: 4_100,
    loans: [L(260_000, 6, "2026-08-10", 2)],
    transfers: [{ direction: "OUT", amount: 38_000, at: "2026-10-05 10:15", status: "REJECTED_NOT_REVERSED", rejectReason: "Cuenta de destino cerrada" }],
  },
  { id: "C31", walletBalance: 7_000, loans: [L(220_000, 6, "2026-08-10", 2)] },
  { id: "C32", walletBalance: 581_000, loans: [L(600_000, 12, "2026-11-01", 0, { disbursement: { status: "CREDITED", at: "2026-10-01 10:00" } })] },
  {
    id: "C33",
    walletBalance: 5_000,
    loans: [L(800_000, 12, "2026-11-06", 0, { disbursement: { status: "PENDING", at: "2026-10-06 16:00", expectedBy: "2026-10-09 15:00" } })],
  },
  {
    id: "C34",
    walletBalance: 2_000,
    loans: [L(450_000, 9, "2026-10-30", 0, { disbursement: { status: "FAILED_RETURNED", at: "2026-09-30 10:00", returnedAt: "2026-10-01 09:00" } })],
  },
  { id: "C35", walletBalance: 12_300, blocked: "IDENTITY_VALIDATION", loans: [L(300_000, 6, "2026-08-15", 2)] },
  { id: "C36", walletBalance: 44_000, loans: [L(480_000, 12, "2026-05-10", 5)] },
  { id: "C37", walletBalance: 9_900, loans: [L(320_000, 6, "2026-08-12", 2)] },
  { id: "C38", walletBalance: 17_600, optIn: false, loans: [L(300_000, 6, "2026-08-18", 2)], charges: [{ feeCode: "FEE-CARD-REPL", at: "2026-09-29 12:00", requested: true }] },
  { id: "C39", walletBalance: 21_000, bounce: true, loans: [L(150_000, 3, "2026-07-20", 3)] },
  { id: "C40", walletBalance: 8_000, loans: [L(250_000, 6, "2026-08-22", 2)] },
  { id: "C41", walletBalance: 6_400, loans: [L(300_000, 6, "2026-07-01", 3)], receipts: [{ variant: "other-payer" }] },
];

/** Default nominal annual rate of the loans whose instalment is not fixed by a flow. */
export const DEFAULT_ANNUAL_RATE = 0.66;

/** Customer number of a persona (`C07` → 7, `cus-0007`). */
export function personaNumber(id: string): number {
  return Number(id.slice(1));
}
