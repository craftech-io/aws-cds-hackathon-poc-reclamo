// Synthetic identifiers of the seed (docs/seed-spec.md §2, §5, §7): operation codes with their check
// digit (Luhn over the 14 digits, docs/architecture-integrations.md §7), the lender's synthetic
// CUIT, CVUs with a prefix no provider uses, documents in a high synthetic range and phones in a
// form no Argentine carrier assigns (subscriber number starting with 0).

const OPERATION_CODE = /^(NTE|SUR|BIL)-(\d{8})-(\d{6})-(\d)$/;

/** Luhn check digit of a string of digits. */
export function luhnDigit(payload: string): number {
  if (!/^\d+$/.test(payload)) throw new RangeError("luhn payload must be digits");
  let sum = 0;
  [...payload].reverse().forEach((character, index) => {
    let digit = Number(character);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  });
  return (10 - (sum % 10)) % 10;
}

export type CodePrefix = "NTE" | "SUR" | "BIL";

/** `NTE-20261006-004817-7`: prefix, local date, sequence and check digit. */
export function operationCode(prefix: CodePrefix, date: string, sequence: number, validDigit = true): string {
  const compactDate = date.replaceAll("-", "");
  const seq = String(sequence).padStart(6, "0");
  if (!/^\d{8}$/.test(compactDate) || seq.length !== 6) throw new RangeError("invalid operation code parts");
  const digit = luhnDigit(compactDate + seq);
  return `${prefix}-${compactDate}-${seq}-${validDigit ? digit : (digit + 5) % 10}`;
}

export function hasValidCheckDigit(code: string): boolean {
  const match = OPERATION_CODE.exec(code);
  if (!match) return false;
  return luhnDigit(`${match[2]}${match[3]}`) === Number(match[4]);
}

/** CUIT `30-99999999-<dv>` with the usual modulo-11 digit (11 → 0, 10 → 9). */
export function syntheticCuit(body = "3099999999"): string {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = [...body].reduce((total, character, index) => total + Number(character) * (weights[index] ?? 0), 0);
  const raw = 11 - (sum % 11);
  const digit = raw === 11 ? 0 : raw === 10 ? 9 : raw;
  return `${body.slice(0, 2)}-${body.slice(2)}-${digit}`;
}

/** CVU `9990` + 18 digits derived from the customer number (22 digits). */
export function syntheticCvu(customerNumber: number): string {
  const body = String(customerNumber).padStart(6, "0");
  const tail = `${body}${String((customerNumber * 7919) % 1_000_000).padStart(6, "0")}${String((customerNumber * 104_729) % 1_000_000).padStart(6, "0")}`;
  return `9990${tail}`;
}

/** DNI in the high synthetic range: personas `99.990.0nn`, other payers `99.991.nnn`. */
export function syntheticDocument(customerNumber: number): string {
  return customerNumber < 1000 ? `99990${String(customerNumber).padStart(3, "0")}` : `99991${String(customerNumber - 1000).padStart(3, "0")}`;
}

/** E.164 digits of a persona or payer phone: `5491100001001`… (`549110000` + 4 digits). */
export function syntheticPhone(customerNumber: number): string {
  return `+5491100001${String(customerNumber).padStart(3, "0")}`;
}

/** Phone of a payer that is not a persona: `+54911000020nn`… (still in the non-assignable form). */
export function payerPhone(customerNumber: number): string {
  return `+549110000${String(2000 + (customerNumber - 1000)).padStart(4, "0")}`;
}

export const NON_ASSIGNABLE_PHONE = /^\+549110000\d{4}$/;
export const SYNTHETIC_CVU = /^9990\d{18}$/;
export const SYNTHETIC_DOCUMENT = /^9999[01]\d{3}$/;
