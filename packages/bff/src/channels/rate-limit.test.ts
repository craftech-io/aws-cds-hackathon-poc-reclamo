import { describe, expect, it } from "vitest";
import { TEST_NOW, testConnector } from "../connector/testing";
import { admitInbound, completeInbound, deliveryKey, firstNoticeOfHour, isProcessed } from "./rate-limit";

const HASH = "a".repeat(64);
const delivery = (id: string) => ({ source: "WHATSAPP", id });

describe("admitInbound", () => {
  it("[FL-105] refuses the message past the limit of the real hour, however the world's clock moves", async () => {
    const { connector } = testConnector();
    const input = (id: string, realNow: Date) => ({ worldId: "qa-run1-sc19", delivery: delivery(id), phoneHash: HASH, realNow, limitPerHour: 3 });
    for (const id of ["wamid.1", "wamid.2", "wamid.3"]) expect((await admitInbound(connector, input(id, TEST_NOW))).outcome).toBe("ADMITTED");
    const fourth = await admitInbound(connector, input("wamid.4", TEST_NOW));
    expect(fourth).toEqual({ outcome: "RATE_LIMITED", limit: 3, realHour: "2026-10-07T13" });
    // "+1 h" on the demo clock is not a real hour: the same real hour still refuses.
    expect((await admitInbound(connector, input("wamid.5", new Date(TEST_NOW.getTime() + 20 * 60_000)))).outcome).toBe("RATE_LIMITED");
    // The next REAL hour opens a new bucket.
    expect((await admitInbound(connector, input("wamid.6", new Date("2026-10-07T14:00:01Z")))).outcome).toBe("ADMITTED");
  });

  it("[FL-105] counts each sender and each world apart", async () => {
    const { connector } = testConnector();
    const admit = (worldId: string, phoneHash: string) => admitInbound(connector, { worldId, delivery: delivery(`wamid.${worldId}.${phoneHash.slice(0, 2)}`), phoneHash, realNow: TEST_NOW, limitPerHour: 1 });
    expect((await admit("demo", HASH)).outcome).toBe("ADMITTED");
    expect((await admit("demo", "b".repeat(64))).outcome).toBe("ADMITTED");
    expect((await admit("g07", HASH)).outcome).toBe("ADMITTED");
  });

  it("[FL-106] answers DUPLICATE for a wamid already processed, without counting it", async () => {
    const { connector } = testConnector();
    const input = { worldId: "demo", delivery: delivery("wamid.dup"), phoneHash: HASH, realNow: TEST_NOW, limitPerHour: 1 };
    expect((await admitInbound(connector, input)).outcome).toBe("ADMITTED");
    await completeInbound(connector, "demo", input.delivery, { outcome: "INTAKE" });
    expect(await isProcessed(connector, "demo", input.delivery)).toBe(true);
    expect(await admitInbound(connector, input)).toEqual({ outcome: "DUPLICATE" });
    expect(await connector.caps.peek({ kind: "RATE", worldId: "demo", phoneHash: HASH, at: TEST_NOW })).toBe(1);
    // A delivery that never completed (the Lambda failed half way) runs again.
    expect(await isProcessed(connector, "demo", delivery("wamid.unfinished"))).toBe(false);
  });

  it("refuses an invalid limit", async () => {
    const { connector } = testConnector();
    await expect(admitInbound(connector, { worldId: "demo", delivery: delivery("w"), phoneHash: HASH, realNow: TEST_NOW, limitPerHour: 0 })).rejects.toThrow(RangeError);
  });
});

describe("deliveryKey and the hourly notice", () => {
  it("keeps a wamid that fits a key segment and hashes one that does not", () => {
    expect(deliveryKey("wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjBDNzE0RTk4RjE4QzA0QjA1AA==")).toBe("wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjBDNzE0RTk4RjE4QzA0QjA1AA==");
    expect(deliveryKey("wamid.a/b")).toMatch(/^h[0-9a-f]{40}$/);
  });

  it("[FL-105] lets the 'too many messages' reply go once per sender and real hour", async () => {
    const { connector } = testConnector();
    expect(await firstNoticeOfHour(connector, "demo", "RATE_NOTICE", HASH, "2026-10-07T13")).toBe(true);
    expect(await firstNoticeOfHour(connector, "demo", "RATE_NOTICE", HASH, "2026-10-07T13")).toBe(false);
    expect(await firstNoticeOfHour(connector, "demo", "RATE_NOTICE", HASH, "2026-10-07T14")).toBe(true);
  });
});
