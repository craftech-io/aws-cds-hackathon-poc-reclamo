// Identity and the customer's file (`GET /customers/by-phone/{phoneHash}`, `GET /customers/{id}`).
// The projection is built field by field from the stored rows: the live phone number, the hashes
// and the full CVU have no place in the answer, so they cannot leak by accident. The live number has
// its own route (`GET /customers/{id}/live-recipient`): app.ts lets only the functions that run the
// outbound gate call it, and here it is answered only in a world that may run live.
import type { Customer, CustomerRef, LiveRecipient } from "@reclamo/core-contract";
import { mayRunLive } from "@reclamo/shared";
import { decodeItem } from "../store/codec";
import { PhoneClaimItem } from "../store/items";
import { SK, coreKeys } from "../store/keys";
import { loadCustomer, notFound } from "./bundle";
import { type LedgerContext, localDate } from "./context";
import { loanSummary } from "./loans";

const MAX_LOANS = 10;

export async function getCustomerByPhone(ctx: LedgerContext, phoneHash: string): Promise<CustomerRef> {
  const row = await ctx.store.get(coreKeys.phonePk(ctx.worldId, phoneHash), SK.CLAIM);
  if (row === undefined) return notFound(ctx, "customer");
  return { customerId: decodeItem(PhoneClaimItem, row).value.customerId };
}

/** `•••• 1234` of a 22-digit CVU. */
export function maskCvu(cvu: string): string {
  return `•••• ${cvu.slice(-4)}`;
}

export async function getCustomer(ctx: LedgerContext, customerId: string): Promise<Customer> {
  const bundle = await loadCustomer(ctx, customerId);
  const meta = bundle.meta.value;
  const account = bundle.account.value;
  const wallet = bundle.wallet.value;
  const today = localDate(ctx.simNow);
  return {
    customerId: meta.customerId,
    firstName: meta.firstName,
    lastName: meta.lastName,
    document: { type: meta.docType, numberMasked: meta.docNumberMasked },
    phoneMasked: meta.phoneMasked,
    emailMasked: meta.emailMasked,
    whatsapp: meta.whatsapp,
    account: {
      status: account.status,
      ...(account.blockCategory === undefined ? {} : { blockCategory: account.blockCategory }),
      ...(account.closure === undefined ? {} : { closureRequestedAtSim: account.closure.requestedAtSim }),
    },
    wallet: {
      balance: wallet.balance,
      cvuMasked: maskCvu(wallet.syntheticCvu),
      outgoingFrozen: wallet.freeze.active,
      ...(wallet.freeze.active && wallet.freeze.atSim !== undefined ? { frozenAtSim: wallet.freeze.atSim } : {}),
    },
    loans: [...bundle.loans.values()].slice(0, MAX_LOANS).map((state) => loanSummary(state, today)),
  };
}

/** The live WhatsApp number of a customer, only in a world that may run live (`demo`, the live QA world). */
export async function getLiveRecipient(ctx: LedgerContext, customerId: string): Promise<LiveRecipient> {
  const bundle = await loadCustomer(ctx, customerId);
  const meta = bundle.meta.value;
  return { customerId: meta.customerId, ...(mayRunLive(ctx.worldId) && meta.liveE164 !== undefined ? { e164: meta.liveE164 } : {}) };
}
