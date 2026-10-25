import type { DataChangeRequest } from "@reclamo/core-contract";
import { describe, expect, it } from "vitest";
import { AccountItem, CustomerItem } from "../store/items";
import { SK, coreKeys } from "../store/keys";
import { maskNewValue, requestDataChange } from "./data-change";
import { WORLD, coreWorld, itemAt, ledgerContext } from "./testing";

function world() {
  return coreWorld([
    { customerId: "cus-0037" },
    { customerId: "cus-0035", phoneHash: "5".repeat(64), accountStatus: "BLOCKED", blockCategory: "IDENTITY_VALIDATION" },
  ]);
}

function change(overrides: Partial<DataChangeRequest> = {}): DataChangeRequest {
  return { complaintId: "cmp-37", idempotencyKey: "cmp-37:email", field: "EMAIL", newValue: "success+nuevo@simulator.amazonses.com", ...overrides };
}

const accountOf = (store: ReturnType<typeof coreWorld>, customerId: string) => AccountItem.parse(itemAt(store, coreKeys.customerPk(WORLD, customerId), SK.ACCOUNT));
const customerOf = (store: ReturnType<typeof coreWorld>, customerId: string) => CustomerItem.parse(itemAt(store, coreKeys.customerPk(WORLD, customerId), SK.META));

describe("change of email or address [FL-054]", () => {
  it("[FL-054] registers the change pending confirmation, to the address on file, without touching the contact data", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const before = customerOf(store, "cus-0037");
    const result = await requestDataChange(ctx, "cus-0037", change());
    expect(result).toMatchObject({ field: "EMAIL", status: "PENDING_CONFIRMATION", confirmationToMasked: before.emailMasked });
    expect(customerOf(store, "cus-0037")).toEqual(before);
    const [record] = accountOf(store, "cus-0037").dataChanges;
    expect(record).toMatchObject({ field: "EMAIL", status: "PENDING_CONFIRMATION", newValueMasked: "s***@simulator.amazonses.com", newValueHash: "f".repeat(64), complaintId: "cmp-37" });
    expect(JSON.stringify(store.dump())).not.toContain("success+nuevo");
  });

  it("[FL-054] an address change is pending too, kept masked; a new request for the field supersedes the old one", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    await requestDataChange(ctx, "cus-0037", change({ field: "ADDRESS", newValue: "Calle Falsa 1234", idempotencyKey: "a1" }));
    const second = await requestDataChange(ctx, "cus-0037", change({ field: "ADDRESS", newValue: "Calle Sintética 99", idempotencyKey: "a2" }));
    expect(second.status).toBe("PENDING_CONFIRMATION");
    expect(accountOf(store, "cus-0037").dataChanges.map((record) => [record.idempotencyKey, record.status, record.newValueMasked])).toEqual([
      ["a1", "SUPERSEDED", "•••1234"],
      ["a2", "PENDING_CONFIRMATION", "•••a 99"],
    ]);
    expect(await requestDataChange(ctx, "cus-0037", change({ field: "ADDRESS", newValue: "otra", idempotencyKey: "a2" }))).toEqual(second);
  });
});

describe("change of phone: human case [FL-055]", () => {
  it("[FL-055] refers a phone change to a person and changes nothing", async () => {
    const store = world();
    const ctx = ledgerContext(store);
    const before = customerOf(store, "cus-0037");
    const result = await requestDataChange(ctx, "cus-0037", change({ field: "PHONE", newValue: "+5491100009999", idempotencyKey: "phone" }));
    expect(result).toEqual({ actionId: result.actionId, field: "PHONE", status: "REFERRED" });
    expect(customerOf(store, "cus-0037")).toEqual(before);
    expect(accountOf(store, "cus-0037").dataChanges[0]).toMatchObject({ status: "REFERRED", newValueMasked: "•••9999" });
  });

  it("[FL-055] refers any change of an account under review", async () => {
    const result = await requestDataChange(ledgerContext(world()), "cus-0035", change({ complaintId: "cmp-35" }));
    expect(result.status).toBe("REFERRED");
    expect(result.confirmationToMasked).toBeUndefined();
  });

  it("masks a new value without keeping it in clear", () => {
    expect(maskNewValue("EMAIL", "Ana@Example.test")).toBe("A***@example.test");
    expect(maskNewValue("PHONE", "+5491100001037")).toBe("•••1037");
  });
});
