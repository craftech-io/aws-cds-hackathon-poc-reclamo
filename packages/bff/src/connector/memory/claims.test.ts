// Claims, scans, sessions and caps over the memory connector: effects that happen once, the scan
// registry resolved once in any order, turn results only in open turns, and abuse caps on the real
// clock that never pass their limit.
import { describe, expect, it } from "vitest";
import { TEST_NOW, testConnector } from "../testing";

describe("idempotency and send claims", () => {
  it("lets the first writer win and hands a repeat what the first stored", async () => {
    const { connector } = testConnector();
    expect(await connector.claims.claimOnce("demo", "REGISTER", "evt-1", { complaintNumber: "R-2026-000123" })).toEqual({ first: true });
    const repeat = await connector.claims.claimOnce("demo", "REGISTER", "evt-1", { complaintNumber: "R-2026-000124" });
    expect(repeat).toMatchObject({ first: false, existing: { result: { complaintNumber: "R-2026-000123" } } });
    expect(await connector.claims.claimOnce("g01", "REGISTER", "evt-1")).toEqual({ first: true });
  });

  it("claims a send once: a repeat after the provider accepted is SENT, without a provider id it is UNKNOWN_DELIVERY", async () => {
    const { connector } = testConnector();
    expect(await connector.claims.claimSend("demo", "msg-1", "WHATSAPP")).toEqual({ status: "CLAIMED" });
    expect(await connector.claims.claimSend("demo", "msg-1", "WHATSAPP")).toEqual({ status: "UNKNOWN_DELIVERY" });
    await connector.write(connector.claims.recordSendOp("demo", "msg-1", "wamid.SIM.1"));
    await expect(connector.write(connector.claims.recordSendOp("demo", "msg-1", "wamid.SIM.2"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.claims.claimSend("demo", "msg-1", "WHATSAPP")).toEqual({ status: "SENT", providerMessageId: "wamid.SIM.1" });
    await expect(connector.write(connector.claims.recordSendOp("demo", "msg-never-claimed", "x"))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("honours a button nonce once", async () => {
    const { connector } = testConnector();
    await connector.write(connector.claims.putNonceOp({ worldId: "demo", nonce: "01JNONCE", action: "ACCEPT_EMAIL", phoneHash: "ph-1", complaintId: "cmp-0001", createdAtReal: TEST_NOW.toISOString() }));
    expect(await connector.claims.getNonce("demo", "01JNONCE")).toMatchObject({ action: "ACCEPT_EMAIL" });
    await connector.write(connector.claims.consumeNonceOp("demo", "01JNONCE"));
    await expect(connector.write(connector.claims.consumeNonceOp("demo", "01JNONCE"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.write(connector.claims.consumeNonceOp("g01", "01JNONCE"))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("leases a QA phone to one holder until it expires", async () => {
    let now = TEST_NOW;
    const { connector } = testConnector({ now: () => now });
    const until = new Date(TEST_NOW.getTime() + 2 * 3_600_000).toISOString();
    expect(await connector.claims.acquireLease("PHONE#9001", "qa-r1-sc01", until)).toBe(true);
    expect(await connector.claims.acquireLease("PHONE#9001", "qa-r2-sc02", until)).toBe(false);
    expect(await connector.claims.acquireLease("PHONE#9001", "qa-r1-sc01", until)).toBe(true);
    await connector.claims.releaseLease("PHONE#9001", "qa-r2-sc02");
    expect((await connector.claims.getLease("PHONE#9001"))?.holder).toBe("qa-r1-sc01");
    now = new Date(TEST_NOW.getTime() + 3 * 3_600_000);
    expect(await connector.claims.acquireLease("PHONE#9001", "qa-r2-sc02", new Date(now.getTime() + 3_600_000).toISOString())).toBe(true);
  });

  it("stores live phones, simulated media and probes outside or inside a world", async () => {
    const { connector, store } = testConnector();
    await connector.claims.putLivePhone({ phoneHash: "ph-live", worldId: "qa-live-r1", leaseUntilReal: "2026-10-07T14:10:00Z" });
    expect(await connector.claims.getLivePhone("ph-live")).toMatchObject({ worldId: "qa-live-r1" });
    expect(store.dump("Runtime").find((row) => row.pk === "LIVEPHONE#ph-live")?.expiresAt).toBe(Date.parse("2026-10-07T14:10:00Z") / 1000);
    await expect(connector.claims.deleteLivePhone("ph-live", "demo")).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.claims.deleteLivePhone("ph-live", "qa-live-r1");
    const simMediaId = `SIM${"a".repeat(32)}`;
    await connector.claims.putSimMedia({ worldId: "demo", simMediaId, s3Key: "W/demo/sim/msg-1/1.png", contentType: "image/png", createdAtReal: TEST_NOW.toISOString() });
    expect(await connector.claims.getSimMedia("demo", simMediaId)).toMatchObject({ contentType: "image/png" });
    await connector.claims.putProbe({ probeId: "probe-1", atReal: TEST_NOW.toISOString(), data: { hash: "abc" } });
    expect(await connector.claims.getProbe("probe-1")).toMatchObject({ data: { hash: "abc" } });
  });
});

describe("scan registry", () => {
  const announceKey = "wa/demo/wamid.SIM.1/";
  const pending = { worldId: "demo", kind: "SCAN" as const, pendingId: "scan-1", openedAtReal: TEST_NOW.toISOString() };

  it("meets the result and the message in either order and resolves once", async () => {
    const { connector } = testConnector();
    await connector.scans.announce({ worldId: "demo", announceKey, source: "WHATSAPP", createdAtReal: TEST_NOW.toISOString() });
    // Result first: the object key the scan reports becomes the real key.
    const withResult = await connector.scans.recordResult("demo", announceKey, { status: "NO_THREATS_FOUND", objectKey: "wa/demo/wamid.SIM.1/mid" });
    expect(withResult).toMatchObject({ result: "NO_THREATS_FOUND", s3Key: "wa/demo/wamid.SIM.1/mid" });
    expect(await connector.scans.recordResult("demo", announceKey, { status: "THREATS_FOUND", objectKey: "x" })).toBeUndefined();
    expect(await connector.scans.setS3Key("demo", announceKey, "wa/demo/wamid.SIM.1/mid")).toBe(true);
    expect(await connector.scans.setS3Key("demo", announceKey, "wa/demo/wamid.SIM.1/other")).toBe(false);

    const bound = await connector.scans.bind("demo", announceKey, { messageId: "msg-1", customerId: "cus-0001", pending });
    expect(bound).toMatchObject({ messageId: "msg-1", result: "NO_THREATS_FOUND" });
    expect(await connector.scans.bind("demo", announceKey, { messageId: "msg-2", customerId: "cus-0001", pending: { ...pending, pendingId: "scan-2" } })).toBeUndefined();
    expect((await connector.runtime.listPending("demo")).map((row) => row.pendingId)).toEqual(["scan-1"]);

    expect(await connector.scans.markResolved("demo", announceKey, "RESULT_FIRST")).toBe(true);
    expect(await connector.scans.markResolved("demo", announceKey, "BIND_FIRST")).toBe(false);
  });

  it("cannot resolve a record that lacks either half, and finds nothing for an orphan result", async () => {
    const { connector } = testConnector();
    const exact = "up/demo/msg-9/1.png";
    await connector.scans.announce({ worldId: "demo", announceKey: exact, s3Key: exact, source: "SIMULATOR", createdAtReal: TEST_NOW.toISOString() });
    await connector.scans.bind("demo", exact, { messageId: "msg-9", customerId: "cus-0002", pending });
    expect(await connector.scans.markResolved("demo", exact, "BIND_FIRST")).toBe(false);
    expect(await connector.scans.recordResult("demo", "up/demo/never-announced.png", { status: "NO_THREATS_FOUND", objectKey: "up/demo/never-announced.png" })).toBeUndefined();
    await expect(connector.scans.bind("demo", exact, { messageId: "msg-9", customerId: "cus-0002", pending: { ...pending, worldId: "g01" } })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("sessions and turn results", () => {
  it("resolves a session and stores tool results only while its turn is open", async () => {
    const { connector } = testConnector();
    await connector.sessions.putSession({
      worldId: "demo",
      sessionId: "ses-1",
      customerId: "cus-0001",
      complaintIds: [],
      identified: false,
      trigger: "CUSTOMER_MESSAGE",
      triggerEventId: "evt-1",
      turnId: "turn-1",
      eventAtSim: "2026-10-07T10:10:00-03:00",
      createdAtReal: TEST_NOW.toISOString(),
    });
    await connector.sessions.addComplaintToSession("demo", "ses-1", "cmp-0001");
    await connector.sessions.addComplaintToSession("demo", "ses-1", "cmp-0001");
    expect(await connector.sessions.getSession("demo", "ses-1")).toMatchObject({ complaintIds: ["cmp-0001"] });

    await connector.sessions.openTurn({ worldId: "demo", turnId: "turn-1", sessionId: "ses-1", openedAtReal: TEST_NOW.toISOString() });
    await connector.sessions.putTurnResult("demo", "turn-1", "get_instalments", { instalments: 4 });
    await connector.sessions.putTurnResult("demo", "turn-1", "reconcile_payment", { result: "MATCHED" });
    expect((await connector.sessions.listTurnResults("demo", "turn-1")).map((row) => [row.seq, row.tool])).toEqual([
      [1, "get_instalments"],
      [2, "reconcile_payment"],
    ]);
    await connector.sessions.closeTurn("demo", "turn-1");
    await expect(connector.sessions.closeTurn("demo", "turn-1")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.sessions.putTurnResult("demo", "turn-1", "send_whatsapp", {})).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.sessions.getTurn("demo", "turn-1")).toMatchObject({ status: "CLOSED", resultSeq: 2 });
  });
});

describe("abuse caps on the real clock", () => {
  it("counts up to the limit and refuses beyond it, per real hour whatever the world clock says", async () => {
    let now = TEST_NOW;
    const { connector } = testConnector({ now: () => now });
    const bucket = () => ({ kind: "RATE" as const, worldId: "g01", phoneHash: "ph-1", at: now });
    expect(await connector.caps.increment(bucket(), 2)).toEqual({ allowed: true, count: 1 });
    expect(await connector.caps.increment(bucket(), 2)).toEqual({ allowed: true, count: 2 });
    expect(await connector.caps.increment(bucket(), 2)).toEqual({ allowed: false, count: 2 });
    expect(await connector.caps.peek(bucket())).toBe(2);
    now = new Date(TEST_NOW.getTime() + 3_600_000);
    expect(await connector.caps.increment(bucket(), 2)).toEqual({ allowed: true, count: 1 });
  });

  it("keeps world, image and global buckets apart, and lets QA prime a bucket", async () => {
    const { connector, store } = testConnector();
    await connector.caps.increment({ kind: "TURNCAP", worldId: "g01", window: "DAY", at: TEST_NOW }, 150);
    await connector.caps.increment({ kind: "IMGCAP", worldId: "g01", customerId: "cus-0001", at: TEST_NOW }, 10);
    await connector.caps.increment({ kind: "GLOBALCAP", pool: "PUBLIC", window: "HOUR", at: TEST_NOW }, 300);
    await connector.caps.set({ kind: "TURNCAP", worldId: "qa-r1-sc12", window: "HOUR", at: TEST_NOW }, 499);
    expect(await connector.caps.increment({ kind: "TURNCAP", worldId: "qa-r1-sc12", window: "HOUR", at: TEST_NOW }, 500)).toEqual({ allowed: true, count: 500 });
    expect(store.dump("Runtime").map((row) => row.pk).sort()).toEqual([
      "GLOBALCAP#PUBLIC#2026-10-07T13",
      "W#g01#IMGCAP#cus-0001#2026-10-07",
      "W#g01#TURNCAP#2026-10-07",
      "W#qa-r1-sc12#TURNCAP#2026-10-07T13",
    ]);
  });

  it("counts challenge failures per customer and keeps a lock until a person lifts it", async () => {
    const { connector, store } = testConnector();
    await connector.caps.recordChallengeFailure("demo", "cus-0001");
    const counted = await connector.caps.recordChallengeFailure("demo", "cus-0001");
    expect(counted).toMatchObject({ status: "COUNTED" });
    expect(counted.ledger.failures).toHaveLength(2);
    expect(store.dump("Runtime")[0]?.expiresAt).toBe(Math.floor(TEST_NOW.getTime() / 1000) + 86_400);
    await connector.caps.lockChallenge("demo", "cus-0001");
    expect(store.dump("Runtime")[0]?.expiresAt).toBeUndefined();
    expect(await connector.caps.getChallenge("demo", "cus-0001")).toMatchObject({ lockedAtReal: TEST_NOW.toISOString() });
    await connector.caps.clearChallenge("demo", "cus-0001");
    expect(await connector.caps.getChallenge("demo", "cus-0001")).toBeUndefined();
  });

  it("never re-arms the TTL of a locked ledger when another failure arrives", async () => {
    let now = TEST_NOW;
    const { connector, store } = testConnector({ now: () => now });
    await connector.caps.recordChallengeFailure("demo", "cus-0001");
    await connector.caps.lockChallenge("demo", "cus-0001");
    now = new Date(TEST_NOW.getTime() + 60_000);
    const after = await connector.caps.recordChallengeFailure("demo", "cus-0001");
    expect(after).toMatchObject({ status: "LOCKED", ledger: { lockedAtReal: TEST_NOW.toISOString() } });
    expect(after.ledger.failures).toHaveLength(1);
    const [row] = store.dump("Runtime");
    expect(row?.expiresAt).toBeUndefined();
    expect(row?.updatedAt).toBe(TEST_NOW.toISOString());
  });
});
