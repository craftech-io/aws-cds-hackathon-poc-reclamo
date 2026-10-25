import { describe, expect, it } from "vitest";
import { getCustomer } from "./accounts";
import { recordWhatsAppOptOut } from "./opt-out";
import { coreWorld, ledgerContext } from "./testing";

describe("the customer's WhatsApp opt-out [FL-006]", () => {
  it("[FL-006] records the opt-out at the world's instant, so the channel policy reads it from the core", async () => {
    const store = coreWorld([{ customerId: "cus-0006" }]);
    const ctx = ledgerContext(store);
    const result = await recordWhatsAppOptOut(ctx, "cus-0006", { via: "KEYWORD", idempotencyKey: "wa-in-0001:opt-out" });
    expect(result).toEqual({ optedOut: true, changed: true, optedOutAtSim: ctx.simNow });
    expect((await getCustomer(ctx, "cus-0006")).whatsapp).toMatchObject({ optedOut: true, optedOutAtSim: ctx.simNow });
  });

  it("[FL-006] is idempotent: a second opt-out keeps the first instant and writes nothing", async () => {
    const store = coreWorld([{ customerId: "cus-0006" }]);
    const ctx = ledgerContext(store);
    const first = await recordWhatsAppOptOut(ctx, "cus-0006", { via: "BUTTON", idempotencyKey: "a" });
    expect(await recordWhatsAppOptOut(ctx, "cus-0006", { via: "KEYWORD", idempotencyKey: "b" })).toEqual({ ...first, changed: false });
    expect(store.commits).toBe(1);
  });

  it("answers NOT_FOUND for a customer the world does not have", async () => {
    const ctx = ledgerContext(coreWorld([{ customerId: "cus-0006" }]));
    await expect(recordWhatsAppOptOut(ctx, "cus-0099", { via: "KEYWORD", idempotencyKey: "c" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
