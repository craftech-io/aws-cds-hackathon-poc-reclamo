// Customers that are not personas (`cus-1001`…, docs/seed-spec.md §5, §7): the other payers whose
// payments fill every settlement batch (10 to 13 lines of their own per batch, so no batch carries
// only a persona's payment). Each payer has up to three short loans paid on their due dates: through
// a collection network inside the settlement window, from the wallet before it. `cus-1017` holds the
// payment whose receipt the persona C41 sends (FL-111).
import { payerPhone, syntheticCvu, syntheticDocument } from "../lib/codes";
import { START_AT_SIM } from "../lib/constants";
import { type CollectionNetwork, NETWORK_CALENDAR, addMonths, businessDateOf, compareInstants, localInstant } from "./calendar";
import { type Ledger, type LoanRecord, addLoan, addPayment, cents } from "./ledger";
import { syntheticAddress } from "./personas";
import { type Rng, rngFor } from "./rng";
import { batchSlots, windowDates } from "./settlements";

const FIRST_NAMES = ["Lucas", "Camila", "Mateo", "Abril", "Bruno", "Julia", "Tobías", "Lara", "Santino", "Malena", "Benjamín", "Olivia", "Thiago", "Renata", "Felipe", "Jazmín", "Gael", "Catalina", "Ian", "Paloma", "Franco", "Delfina", "Joaquina", "Simón", "Morena", "Elías", "Pilar", "Lisandro", "Zoe", "Ramiro"];
const LAST_NAMES = ["Albornoz", "Bustos", "Cáceres", "Domínguez", "Escobar", "Ferreira", "Godoy", "Herrera", "Ibáñez", "Juárez", "Ledesma", "Molina", "Núñez", "Ojeda", "Ponce", "Quinteros", "Rojas", "Salinas", "Toledo", "Urquiza", "Vera", "Zalazar", "Arce", "Benítez", "Coria", "Díaz", "Funes", "Gallo", "Luna", "Sosa"];

/** The payer of the C41 story and the payment it made (`NORTE`, Friday 02/10). */
export const OTHER_PAYER = { number: 1017, loanId: "L-1017", paidAt: localInstant("2026-10-02", "11:05") } as const;

/** The names a payer gets, in the order payers are created (NameCheck records only these). */
export function payerName(number: number): { firstName: string; lastName: string } {
  const index = number - 1001;
  return { firstName: FIRST_NAMES[index % FIRST_NAMES.length] ?? "Lucas", lastName: LAST_NAMES[(index * 7 + 3) % LAST_NAMES.length] ?? "Rojas" };
}

interface PayerState {
  readonly number: number;
  loans: number;
}

type Slot = ReturnType<typeof batchSlots>[number];

function addPayer(ledger: Ledger, number: number): PayerState {
  ledger.customers.push({
    number,
    customerId: `cus-${number}`,
    ...payerName(number),
    phone: payerPhone(number),
    document: syntheticDocument(number),
    cvu: syntheticCvu(number),
    address: syntheticAddress(number),
    optIn: true,
    bounce: false,
    walletBalance: cents(1_000 + ((number * 613) % 40_000)),
  });
  return { number, loans: 0 };
}

function randomTime(rng: Rng, fromHour: number, toHour: number): string {
  const minutes = rng.int(fromHour * 60, toHour * 60 - 1);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

class Payers {
  private readonly slots: readonly Slot[] = batchSlots();
  private readonly windowStart: string = windowDates()[0] ?? "";
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly ledger: Ledger,
    private readonly rng: Rng,
  ) {}

  slotOf(network: CollectionNetwork, paidAt: string): Slot | undefined {
    const businessDate = businessDateOf(network, paidAt);
    return this.slots.find((slot) => slot.network === network && slot.businessDate === businessDate);
  }

  count(slot: Slot): number {
    return this.counts.get(`${slot.network}#${slot.businessDate}`) ?? 0;
  }

  /** A network payment of a payer into the batch it lands in. */
  payThrough(loan: LoanRecord, number: number, network: CollectionNetwork, paidAt: string): void {
    const slot = this.slotOf(network, paidAt);
    if (!slot) throw new Error(`no batch for ${network} ${paidAt}`);
    addPayment(this.ledger, { loan, network, instalments: [number], paidAt, applied: slot.status === "PUBLISHED", terminal: `T-${this.rng.int(1000, 9999)}` });
    const key = `${slot.network}#${slot.businessDate}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Every instalment of `loan` due before the start is paid on its due date; instalment `k` through `forced`. */
  payDue(loan: LoanRecord, k: number, forced: { network: CollectionNetwork; paidAt: string }): void {
    for (const row of loan.rows) {
      if (row.number === k) {
        this.payThrough(loan, k, forced.network, forced.paidAt);
        continue;
      }
      if (compareInstants(localInstant(row.dueDate, "00:00"), START_AT_SIM) >= 0) break;
      const network: CollectionNetwork = this.rng.next() < 0.5 ? "NORTE" : "SUR";
      const paidAt = localInstant(row.dueDate, row.dueDate === START_AT_SIM.slice(0, 10) ? randomTime(this.rng, 8, 10) : randomTime(this.rng, 8, 15));
      const target = row.dueDate >= this.windowStart && this.slotOf(network, paidAt) ? network : undefined;
      if (target) this.payThrough(loan, row.number, target, paidAt);
      else addPayment(this.ledger, { loan, network: "WALLET", instalments: [row.number], paidAt: localInstant(row.dueDate, "07:00"), applied: true });
    }
  }

  newLoan(payer: PayerState, dueDate: string, k: number): LoanRecord {
    payer.loans += 1;
    const count = Math.max(k, this.rng.int(3, 6));
    return addLoan(this.ledger, {
      loanId: payer.loans === 1 ? `L-${payer.number}` : `L-${payer.number}-${payer.loans}`,
      customerId: `cus-${payer.number}`,
      principal: cents(this.rng.int(10, 60) * 10_000),
      count,
      annualRate: 0.6 + this.rng.int(0, 12) / 100,
      firstDue: addMonths(dueDate, -(k - 1), Number(dueDate.slice(8, 10))),
    });
  }

  run(): void {
    const other = addPayer(this.ledger, OTHER_PAYER.number);
    this.payDue(this.newLoan(other, OTHER_PAYER.paidAt.slice(0, 10), 2), 2, { network: "NORTE", paidAt: OTHER_PAYER.paidAt });
    let next = 1001;
    let current: PayerState | undefined;
    for (const slot of this.slots) {
      const target = this.rng.int(10, 13);
      while (this.count(slot) < target) {
        if (!current || current.loans >= 3) {
          if (next === OTHER_PAYER.number) next += 1;
          current = addPayer(this.ledger, next);
          next += 1;
        }
        const cutoffHour = Number(NETWORK_CALENDAR[slot.network].cutoff.slice(0, 2));
        const lastHour = slot.businessDate === START_AT_SIM.slice(0, 10) ? 10 : cutoffHour;
        const paidAt = localInstant(slot.businessDate, randomTime(this.rng, 8, lastHour));
        const k = this.rng.int(1, 3);
        this.payDue(this.newLoan(current, slot.businessDate, k), k, { network: slot.network, paidAt });
      }
    }
  }
}

/** Adds the other payers until every batch holds at least 10 of their lines. */
export function buildPayers(ledger: Ledger): void {
  new Payers(ledger, rngFor("payers")).run();
}
