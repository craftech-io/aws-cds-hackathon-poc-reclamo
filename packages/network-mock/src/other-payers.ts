// Payments of other payers in a batch the mock opens itself (docs/architecture-integrations.md §6.1:
// "cada lote trae también pagos de clientes que no son personas del simulador"). A template's batches
// already carry them (the seed writes them); a batch opened by a registered collection gets a few
// deterministic ones, so a settlement file never holds only the customer's own payment and a
// reconciliation always has to tell lines apart by payer.
//
// Their customers and loans (`cus-9xxx`, `L-9xxx`) are outside the personas (`cus-00nn`) and the
// seed's payers (`cus-1xxx`); their codes use a `9` serial, which neither the seed nor a receipt uses.
import { createHash } from "node:crypto";
import type { CollectionNetwork, SettlementLine } from "@reclamo/core-contract";
import { argentinaInstant } from "./business-date";

const PREFIX: Readonly<Record<CollectionNetwork, string>> = { NORTE: "NTE", SUR: "SUR" };
/** Wall-clock times of the other payers' payments, all before the earliest cut-off (16:00). */
const TIMES = ["09:12", "11:47", "14:05"] as const;

/** Luhn check digit of a string of digits. */
export function luhnDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new RangeError("digits only");
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index]);
    const doubled = index % 2 === 0 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return (10 - (sum % 10)) % 10;
}

/** `NTE-20261007-912345-3`: network prefix, payment date, 6-digit serial and Luhn over the 14 digits. */
export function operationCodeFor(network: CollectionNetwork, paidDate: string, serial: string): string {
  const yyyymmdd = paidDate.replaceAll("-", "");
  if (!/^\d{8}$/.test(yyyymmdd) || !/^\d{6}$/.test(serial)) throw new RangeError("invalid operation code parts");
  return `${PREFIX[network]}-${yyyymmdd}-${serial}-${luhnDigit(yyyymmdd + serial)}`;
}

function numberAt(hash: Buffer, offset: number, modulo: number): number {
  return hash.readUInt32BE(offset) % modulo;
}

/** The other payers of a batch opened by the mock: same inputs, same lines. */
export function otherPayerLines(worldId: string, network: CollectionNetwork, businessDate: string): SettlementLine[] {
  return TIMES.map((time, index) => {
    const hash = createHash("sha256").update(`${worldId}|${network}|${businessDate}|${index}`).digest();
    const payer = 9000 + numberAt(hash, 0, 1000);
    // The last digit is the index: the payers of one batch never share a code.
    const serial = `9${numberAt(hash, 4, 10_000).toString().padStart(4, "0")}${index}`;
    return {
      network,
      businessDate,
      operationCode: operationCodeFor(network, businessDate, serial),
      paidAt: argentinaInstant(businessDate, time),
      amount: (15_000 + numberAt(hash, 8, 235_000)) * 100,
      customerRef: `cus-${payer}`,
      loanRef: `L-${payer}`,
      instalment: 1 + numberAt(hash, 12, 12),
      terminal: `T-${(1 + numberAt(hash, 16, 9_998)).toString().padStart(4, "0")}`,
    };
  });
}
