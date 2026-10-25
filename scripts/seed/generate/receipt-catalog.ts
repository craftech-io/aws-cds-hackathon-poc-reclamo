// Which receipts the seed renders and the ground truth of each (docs/seed-spec.md §9, §12): the
// persona receipts of the scenarios (their payments in the ledger) and the eval set of `EV-2` (64
// images: 20 legible, 15 blurry, 10 fake check digit, 5 unknown codes, 5 injections, 5 drawings,
// 3 tampered chunks and the C41 receipt of another payer), with the `SR` subset marked.
import { type CodePrefix, operationCode } from "../lib/codes";
import { sha256Hex } from "../lib/json";
import type { Ledger, PaymentRecord } from "./ledger";
import { OTHER_PAYER } from "./payers";
import { PERSONA_SPECS } from "./persona-specs";
import type { PersonaReceiptSource } from "./personas";
import { type ReceiptFields, renderBlurry, renderNotReceipt, renderReadable } from "./receipts";
import { type Rng, rngFor } from "./rng";

export type ReceiptVariant = "legible" | "blurry" | "fake-check" | "fake-unknown" | "injection" | "not-receipt" | "other-payer" | "tampered-chunk";

export interface ReceiptTruth {
  readonly result: "READ" | "UNREADABLE" | "INVALID_RECEIPT" | "NOT_A_RECEIPT" | "DISAGREE";
  readonly fields?: { readonly network: string; readonly operationCode: string; readonly amount: number; readonly paidAtLocal: string; readonly payerReference: string };
  readonly reconciliation?: "MATCHED" | "PENDING_BATCH" | "ALREADY_APPLIED" | "NOT_FOUND" | "PAYER_MISMATCH";
  readonly suspiciousText?: boolean;
  readonly duplicateOf?: string;
}

export interface ReceiptFile {
  readonly id: string;
  readonly variant: ReceiptVariant;
  /** Path under `media/receipts/`. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly chunk?: string;
  readonly persona?: string;
  readonly seq?: number;
  readonly eval: boolean;
  readonly sr: boolean;
  readonly truth: ReceiptTruth;
}

const PERSONA_RECONCILIATION: Readonly<Record<string, ReceiptTruth["reconciliation"]>> = {
  C01: "PENDING_BATCH",
  C04: "MATCHED",
  C11: "ALREADY_APPLIED",
  C12: "MATCHED",
  C13: "MATCHED",
  C14: "MATCHED",
  C15: "MATCHED",
  C17: "MATCHED",
  C19: "MATCHED",
};

const SR_PERSONAS = new Set(["C01", "C04", "C11", "C12", "C13", "C14", "C15", "C16", "C17", "C19", "C41"]);

export function fieldsOf(payment: PaymentRecord): ReceiptFields {
  return {
    network: payment.network,
    operationCode: payment.operationCode,
    amount: payment.amount,
    paidAtLocal: payment.paidAt.slice(0, 16),
    customerRef: payment.customerId,
    loanRef: payment.loanId,
    instalment: payment.instalments[0] ?? 1,
    terminal: payment.terminal ?? "T-0001",
  };
}

function truthFields(fields: ReceiptFields): ReceiptTruth["fields"] {
  return { network: fields.network, operationCode: fields.operationCode, amount: fields.amount, paidAtLocal: fields.paidAtLocal, payerReference: fields.customerRef };
}

function file(id: string, variant: ReceiptVariant, rendered: { bytes: Uint8Array; chunk?: string }, truth: ReceiptTruth, extra: Partial<Pick<ReceiptFile, "persona" | "seq">> & { eval: boolean; sr: boolean }): ReceiptFile {
  return { id, variant, path: `${variant}/${id}.png`, bytes: rendered.bytes, sha256: sha256Hex(rendered.bytes), ...(rendered.chunk ? { chunk: rendered.chunk } : {}), truth, ...extra };
}

const PREFIX: Readonly<Record<string, CodePrefix>> = { NORTE: "NTE", SUR: "SUR", WALLET: "BIL" };

/** A valid-digit code that no payment of the ledger uses (the fake-unknown receipts). */
function unknownCode(ledger: Ledger, fields: ReceiptFields, seq: number): string {
  const used = new Set(ledger.payments.map((payment) => payment.operationCode));
  for (let candidate = seq; ; candidate += 1) {
    const code = operationCode(PREFIX[fields.network] ?? "NTE", fields.paidAtLocal.slice(0, 10), candidate);
    if (!used.has(code)) return code;
  }
}

function invalidCode(fields: ReceiptFields): string {
  const [prefix = "NTE", date = "", seq = "0"] = fields.operationCode.split("-");
  return operationCode(prefix as CodePrefix, `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, Number(seq), false);
}

function personaReceipts(ledger: Ledger, sources: readonly PersonaReceiptSource[], openReceiptComplaint: string, rng: Rng): ReceiptFile[] {
  const out: ReceiptFile[] = [];
  for (const source of sources) {
    const fields = fieldsOf(source.payment);
    const sr = SR_PERSONAS.has(source.personaId);
    const id = source.personaId.toLowerCase();
    if (source.variant === "blurry") {
      for (const seq of [1, 2]) out.push(file(`${id}-${seq}`, "blurry", renderBlurry(fields, rngFor(`receipt:${id}-${seq}`)), { result: "UNREADABLE" }, { persona: source.personaId, seq, eval: false, sr }));
      continue;
    }
    const reconciliation = PERSONA_RECONCILIATION[source.personaId];
    const truth: ReceiptTruth = {
      result: "READ",
      fields: truthFields(fields),
      ...(reconciliation ? { reconciliation } : {}),
      ...(source.variant === "injection" ? { suspiciousText: true } : {}),
      ...(source.personaId === "C17" ? { duplicateOf: openReceiptComplaint } : {}),
    };
    out.push(file(`${id}-1`, source.variant, renderReadable(fields, sha256Hex, { injection: source.variant === "injection" }), truth, { persona: source.personaId, seq: 1, eval: false, sr }));
  }
  const loanOf = (customerId: string): PaymentRecord | undefined => ledger.payments.find((payment) => payment.customerId === customerId);
  const base = (personaId: string, at: string): ReceiptFields => {
    const customerId = `cus-${personaId.slice(1).padStart(4, "0")}`;
    const loan = ledger.loans.find((candidate) => candidate.customerId === customerId);
    const overdue = loan?.rows.find((row) => !ledger.payments.some((payment) => payment.loanId === loan.loanId && payment.applied && payment.instalments.includes(row.number)));
    const paid = loanOf(customerId);
    return {
      network: "NORTE",
      operationCode: operationCode("NTE", at.slice(0, 10), 30_000 + rng.int(0, 9_999)),
      amount: overdue?.amount ?? paid?.amount ?? 10_000_00,
      paidAtLocal: at,
      customerRef: customerId,
      loanRef: loan?.loanId ?? "L-0000",
      instalment: overdue?.number ?? 1,
      terminal: `T-${rng.int(1000, 9999)}`,
    };
  };
  for (const spec of PERSONA_SPECS) {
    for (const receipt of spec.receipts ?? []) {
      const id = `${spec.id.toLowerCase()}-1`;
      const meta = { persona: spec.id, seq: 1, eval: receipt.variant === "other-payer", sr: SR_PERSONAS.has(spec.id) };
      const printedAt = (receipt.at ?? "").replace(" ", "T");
      if (receipt.variant === "fake-check") {
        const shown = base(spec.id, printedAt);
        const fake = { ...shown, operationCode: invalidCode(shown) };
        out.push(file(id, "fake-check", renderReadable(fake, sha256Hex), { result: "INVALID_RECEIPT", fields: truthFields(fake) }, meta));
      } else if (receipt.variant === "fake-unknown") {
        const shown = base(spec.id, printedAt);
        const fake = { ...shown, operationCode: unknownCode(ledger, shown, 990_001) };
        out.push(file(id, "fake-unknown", renderReadable(fake, sha256Hex), { result: "READ", fields: truthFields(fake), reconciliation: "NOT_FOUND" }, meta));
      } else if (receipt.variant === "not-receipt") {
        out.push(file(id, "not-receipt", renderNotReceipt(rngFor(`receipt:${id}`)), { result: "NOT_A_RECEIPT" }, meta));
      } else {
        const other = ledger.payments.find((payment) => payment.loanId === OTHER_PAYER.loanId && payment.paidAt === OTHER_PAYER.paidAt);
        if (!other) throw new Error("the other payer's payment of C41 is missing");
        const shown = fieldsOf(other);
        out.push(file(id, "other-payer", renderReadable(shown, sha256Hex), { result: "READ", fields: truthFields(shown), reconciliation: "PAYER_MISMATCH" }, meta));
      }
    }
  }
  return out;
}

const EVAL_COUNTS: ReadonlyArray<readonly [ReceiptVariant, number]> = [
  ["legible", 20],
  ["blurry", 15],
  ["fake-check", 10],
  ["fake-unknown", 5],
  ["injection", 5],
  ["not-receipt", 5],
  ["tampered-chunk", 3],
];

function evalReceipts(ledger: Ledger, rng: Rng): ReceiptFile[] {
  const pool = rng.shuffle(ledger.payments.filter((payment) => payment.network !== "WALLET" && payment.applied && Number(payment.customerId.slice(4)) >= 1000 && payment.loanId !== OTHER_PAYER.loanId));
  let cursor = 0;
  const nextFields = (): ReceiptFields => {
    const payment = pool[cursor];
    cursor += 1;
    if (!payment) throw new Error("not enough payer payments for the receipt eval");
    return fieldsOf(payment);
  };
  const out: ReceiptFile[] = [];
  for (const [variant, count] of EVAL_COUNTS) {
    for (let index = 1; index <= count; index += 1) {
      const id = `ev-${variant}-${String(index).padStart(2, "0")}`;
      if (variant === "not-receipt") {
        out.push(file(id, variant, renderNotReceipt(rngFor(`receipt:${id}`)), { result: "NOT_A_RECEIPT" }, { eval: true, sr: false }));
        continue;
      }
      const fields = nextFields();
      if (variant === "legible") out.push(file(id, variant, renderReadable(fields, sha256Hex), { result: "READ", fields: truthFields(fields) }, { eval: true, sr: false }));
      if (variant === "blurry") out.push(file(id, variant, renderBlurry(fields, rngFor(`receipt:${id}`)), { result: "UNREADABLE" }, { eval: true, sr: false }));
      if (variant === "injection") out.push(file(id, variant, renderReadable(fields, sha256Hex, { injection: true }), { result: "READ", fields: truthFields(fields), suspiciousText: true }, { eval: true, sr: false }));
      if (variant === "fake-check") {
        const fake = { ...fields, operationCode: invalidCode(fields) };
        out.push(file(id, variant, renderReadable(fake, sha256Hex), { result: "INVALID_RECEIPT", fields: truthFields(fake) }, { eval: true, sr: false }));
      }
      if (variant === "fake-unknown") {
        const fake = { ...fields, operationCode: unknownCode(ledger, fields, 980_000 + index * 11) };
        out.push(file(id, variant, renderReadable(fake, sha256Hex), { result: "READ", fields: truthFields(fake), reconciliation: "NOT_FOUND" }, { eval: true, sr: false }));
      }
      if (variant === "tampered-chunk") {
        const chunkFields = { ...fields, amount: fields.amount + 100_000 };
        out.push(file(id, variant, renderReadable(fields, sha256Hex, { chunkFields }), { result: "DISAGREE", fields: truthFields(fields) }, { eval: true, sr: false }));
      }
    }
  }
  return out;
}

/** Every receipt of the seed: the personas' first, then the eval set. */
export function buildReceipts(ledger: Ledger, sources: readonly PersonaReceiptSource[], openReceiptComplaint: string): ReceiptFile[] {
  return [...personaReceipts(ledger, sources, openReceiptComplaint, rngFor("receipts:personas")), ...evalReceipts(ledger, rngFor("receipts:eval"))];
}
