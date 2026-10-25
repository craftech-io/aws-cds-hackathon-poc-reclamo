// `POST /customers/{customerId}/whatsapp/opt-out`: the customer's WhatsApp opt-out (FL-006), by the
// keyword or the button the inbound adapter recognised. From its instant on, the channel policy
// (`CH-OPTOUT`) lets only the opt-out confirmation through. Idempotent: an opt-out already in force
// answers `changed false` with its instant; only the customer opts out, and only staff could ever undo it.
import type { WhatsAppOptOutRequest, WhatsAppOptOutResult } from "@reclamo/core-contract";
import { putChanged } from "../store/codec";
import { loadCustomer } from "./bundle";
import { commitWithRetry } from "./claims";
import type { LedgerContext } from "./context";

export async function recordWhatsAppOptOut(ctx: LedgerContext, customerId: string, _request: WhatsAppOptOutRequest): Promise<WhatsAppOptOutResult> {
  return commitWithRetry<WhatsAppOptOutResult>(async () => {
    const bundle = await loadCustomer(ctx, customerId);
    const customer = bundle.meta.value;
    if (customer.whatsapp.optedOut) {
      return { writes: [], result: { optedOut: true, changed: false, optedOutAtSim: customer.whatsapp.optedOutAtSim ?? ctx.simNow } };
    }
    const whatsapp = { ...customer.whatsapp, optedOut: true, optedOutAtSim: ctx.simNow };
    return { writes: [putChanged(bundle.meta, { ...customer, whatsapp }, bundle.stamp)], result: { optedOut: true, changed: true, optedOutAtSim: ctx.simNow } };
  }, ctx);
}
