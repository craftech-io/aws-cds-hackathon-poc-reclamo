// A customer's rows, read in one consistent query of their partition and typed by entity. Every
// route works from this bundle: ownership checks, projections and the writes that condition on the
// versions read here.
import { CorruptItemError, type Stored, type WriteStamp, decodeItem, expiryOf } from "../store/codec";
import {
  AccountItem,
  ChargeItem,
  CreditNoteItem,
  CustomerItem,
  InstalmentItem,
  LoanItem,
  MovementItem,
  OwnerItem,
  PaymentItem,
  PayoffQuoteItem,
  TransferItem,
  WalletItem,
} from "../store/items";
import { SK, coreKeys } from "../store/keys";
import type { StoredItem } from "../store/port";
import { type LedgerContext, LedgerError, compareText, instantMs } from "./context";

export interface LoanState {
  readonly loan: Stored<LoanItem>;
  /** Sorted by number. */
  readonly instalments: readonly Stored<InstalmentItem>[];
  readonly payments: readonly Stored<PaymentItem>[];
}

export interface CustomerBundle {
  readonly customerId: string;
  readonly pk: string;
  readonly meta: Stored<CustomerItem>;
  readonly account: Stored<AccountItem>;
  readonly wallet: Stored<WalletItem>;
  readonly loans: ReadonlyMap<string, LoanState>;
  /** Sorted by instant, oldest first. */
  readonly movements: readonly Stored<MovementItem>[];
  readonly charges: ReadonlyMap<string, Stored<ChargeItem>>;
  readonly transfers: readonly Stored<TransferItem>[];
  readonly creditNotes: readonly Stored<CreditNoteItem>[];
  readonly quotes: ReadonlyMap<string, Stored<PayoffQuoteItem>>;
  /** How new rows of this customer are stamped (world, instant, inherited expiry). */
  readonly stamp: WriteStamp;
}

/** `NOT_FOUND`, or `WORLD_NOT_FOUND` when the world itself has no rows in the core. */
export async function notFound(ctx: LedgerContext, what: string): Promise<never> {
  if (!(await ctx.store.worldHasItems(ctx.worldId))) throw new LedgerError("WORLD_NOT_FOUND", "unknown world");
  throw new LedgerError("NOT_FOUND", `${what} not found`);
}

function single<T>(value: T | undefined, entity: string): T {
  if (value === undefined) throw new CorruptItemError(entity);
  return value;
}

export async function loadCustomer(ctx: LedgerContext, customerId: string): Promise<CustomerBundle> {
  const pk = coreKeys.customerPk(ctx.worldId, customerId);
  const rows = await ctx.store.query(pk);
  const metaRow = rows.find((row) => row.sk === SK.META);
  if (metaRow === undefined) return notFound(ctx, "customer");

  let account: Stored<AccountItem> | undefined;
  let wallet: Stored<WalletItem> | undefined;
  const loans = new Map<string, { loan?: Stored<LoanItem>; instalments: Stored<InstalmentItem>[]; payments: Stored<PaymentItem>[] }>();
  const loanEntry = (loanId: string) => {
    const entry = loans.get(loanId) ?? { instalments: [], payments: [] };
    loans.set(loanId, entry);
    return entry;
  };
  const movements: Stored<MovementItem>[] = [];
  const charges = new Map<string, Stored<ChargeItem>>();
  const transfers: Stored<TransferItem>[] = [];
  const creditNotes: Stored<CreditNoteItem>[] = [];
  const quotes = new Map<string, Stored<PayoffQuoteItem>>();

  for (const row of rows) {
    switch (row.entity) {
      case "Account":
        account = decodeItem(AccountItem, row);
        break;
      case "Wallet":
        wallet = decodeItem(WalletItem, row);
        break;
      case "Loan": {
        const loan = decodeItem(LoanItem, row);
        loanEntry(loan.value.loanId).loan = loan;
        break;
      }
      case "Instalment": {
        const instalment = decodeItem(InstalmentItem, row);
        loanEntry(instalment.value.loanId).instalments.push(instalment);
        break;
      }
      case "Payment": {
        const payment = decodeItem(PaymentItem, row);
        loanEntry(payment.value.loanId).payments.push(payment);
        break;
      }
      case "Movement":
        movements.push(decodeItem(MovementItem, row));
        break;
      case "Charge": {
        const charge = decodeItem(ChargeItem, row);
        charges.set(charge.value.chargeId, charge);
        break;
      }
      case "Transfer":
        transfers.push(decodeItem(TransferItem, row));
        break;
      case "CreditNote":
        creditNotes.push(decodeItem(CreditNoteItem, row));
        break;
      case "PayoffQuote": {
        const quote = decodeItem(PayoffQuoteItem, row);
        quotes.set(quote.value.quoteId, quote);
        break;
      }
      default:
        break;
    }
  }

  const loanStates = new Map<string, LoanState>();
  for (const [loanId, entry] of loans) {
    const loan = single(entry.loan, "Loan");
    const instalments = [...entry.instalments].sort((a, b) => a.value.number - b.value.number);
    const payments = [...entry.payments].sort((a, b) => instantMs(a.value.appliedAtSim) - instantMs(b.value.appliedAtSim) || compareText(a.value.paymentId, b.value.paymentId));
    loanStates.set(loanId, { loan, instalments, payments });
  }
  movements.sort((a, b) => compareText(a.sk, b.sk));
  const expiresAt = expiryOf(metaRow);

  return {
    customerId,
    pk,
    meta: decodeItem(CustomerItem, metaRow),
    account: single(account, "Account"),
    wallet: single(wallet, "Wallet"),
    loans: loanStates,
    movements,
    charges,
    transfers,
    creditNotes,
    quotes,
    stamp: { worldId: ctx.worldId, simNow: ctx.simNow, ...(expiresAt === undefined ? {} : { expiresAt }) },
  };
}

async function ownerOf(ctx: LedgerContext, pk: string): Promise<string | undefined> {
  const row: StoredItem | undefined = await ctx.store.get(pk, SK.OWNER);
  return row === undefined ? undefined : decodeItem(OwnerItem, row).value.customerId;
}

/**
 * The bundle of the loan's customer. With `customerId` (every money route and the payoff quote) a
 * loan of another customer is `FORBIDDEN`: the core never acts on a loan the session does not own.
 */
export async function loadLoan(ctx: LedgerContext, loanId: string, customerId?: string): Promise<{ bundle: CustomerBundle; state: LoanState }> {
  const owner = await ownerOf(ctx, coreKeys.loanOwnerPk(ctx.worldId, loanId));
  if (owner === undefined) return notFound(ctx, "loan");
  if (customerId !== undefined && owner !== customerId) throw new LedgerError("FORBIDDEN", "the loan is not this customer's");
  const bundle = await loadCustomer(ctx, owner);
  const state = bundle.loans.get(loanId);
  if (state === undefined) throw new CorruptItemError("LoanOwner");
  return { bundle, state };
}

/** The bundle of the charge's customer; `FORBIDDEN` when `customerId` is given and is not the owner. */
export async function loadCharge(ctx: LedgerContext, chargeId: string, customerId?: string): Promise<{ bundle: CustomerBundle; charge: Stored<ChargeItem> }> {
  const owner = await ownerOf(ctx, coreKeys.chargeOwnerPk(ctx.worldId, chargeId));
  if (owner === undefined) return notFound(ctx, "charge");
  if (customerId !== undefined && owner !== customerId) throw new LedgerError("FORBIDDEN", "the charge is not this customer's");
  const bundle = await loadCustomer(ctx, owner);
  const charge = bundle.charges.get(chargeId);
  if (charge === undefined) throw new CorruptItemError("ChargeOwner");
  return { bundle, charge };
}
