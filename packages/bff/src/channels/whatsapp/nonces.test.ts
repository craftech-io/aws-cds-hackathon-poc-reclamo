import { describe, expect, it } from "vitest";
import { TEST_NOW, testConnector } from "../../connector/testing";
import { toMetaMessage } from "./meta-message";
import { consumeNonce, issueNonces, nonceOps, resolveNonce } from "./nonces";

const PHONE_HASH = "c".repeat(64);
const issue = (connector: ReturnType<typeof testConnector>["connector"], buttons: Parameters<typeof issueNonces>[1]["buttons"], worldId = "demo") =>
  issueNonces(connector, { worldId, customerId: "cus-0010", phoneHash: PHONE_HASH, messageId: "msg-out-list", buttons, now: TEST_NOW });
const resolve = (connector: ReturnType<typeof testConnector>["connector"], value: string, overrides: Partial<Parameters<typeof resolveNonce>[1]> = {}) =>
  resolveNonce(connector, { worldId: "demo", value, phoneHash: PHONE_HASH, customerId: "cus-0010", now: TEST_NOW, ...overrides });

describe("button nonces [FL-005]", () => {
  it("[FL-005] gives each loan row its own opaque nonce that resolves to that loan only", async () => {
    const { connector } = testConnector();
    const [first, second] = await issue(connector, [
      { action: "CHOOSE_LOAN", loanId: "L-0001" },
      { action: "CHOOSE_LOAN", loanId: "L-0002" },
    ]);
    expect(first).toMatch(/^[0-9A-Z]{26}$/);
    expect(first).not.toBe(second);
    expect(await resolve(connector, first ?? "")).toMatchObject({ ok: true, nonce: { action: "CHOOSE_LOAN", loanId: "L-0001", messageId: "msg-out-list" } });
    expect(await resolve(connector, second ?? "")).toMatchObject({ ok: true, nonce: { loanId: "L-0002" } });
    // The rows of a list carry the nonces, never the loan ids.
    const list = toMetaMessage({ kind: "list", body: "¿Sobre cuál es tu reclamo?", buttonTitle: "Elegir préstamo", rows: [{ id: first ?? "", title: "Préstamo 0001" }] }, "+5491100001010");
    expect(JSON.stringify(list)).not.toContain("L-0001");
  });

  it("[FL-005] resolves only for the same phone, customer and world", async () => {
    const { connector } = testConnector();
    const [nonce = ""] = await issue(connector, [{ action: "CHOOSE_LOAN", loanId: "L-0001" }]);
    expect(await resolve(connector, nonce, { phoneHash: "d".repeat(64) })).toMatchObject({ ok: false, reason: "NONCE_FOREIGN" });
    expect(await resolve(connector, nonce, { customerId: "cus-0011" })).toMatchObject({ ok: false, reason: "NONCE_FOREIGN" });
    expect(await resolve(connector, nonce, { worldId: "g07" })).toEqual({ ok: false, reason: "NONCE_UNKNOWN" });
    expect(await resolve(connector, "not a nonce!")).toEqual({ ok: false, reason: "NONCE_UNKNOWN" });
  });

  it("[FL-005] expires after seven real days", async () => {
    const { connector } = testConnector();
    const [nonce = ""] = await issue(connector, [{ action: "TALK_TO_HUMAN" }]);
    expect(await resolve(connector, nonce, { now: new Date(TEST_NOW.getTime() + 7 * 24 * 3_600_000 - 1) })).toMatchObject({ ok: true });
    expect(await resolve(connector, nonce, { now: new Date(TEST_NOW.getTime() + 7 * 24 * 3_600_000) })).toMatchObject({ ok: false, reason: "NONCE_EXPIRED" });
  });

  it("honours a one-shot action once and a repeatable one every time", async () => {
    const { connector } = testConnector();
    const [consent = "", human = ""] = await issue(connector, [{ action: "ACCEPT_EMAIL", complaintId: "cmp-0001" }, { action: "TALK_TO_HUMAN" }]);
    const accepted = await resolve(connector, consent);
    if (!accepted.ok) throw new Error("expected the consent nonce to resolve");
    expect(await consumeNonce(connector, accepted.nonce)).toBe(true);
    expect(await consumeNonce(connector, accepted.nonce)).toBe(false);
    expect(await resolve(connector, consent)).toMatchObject({ ok: false, reason: "NONCE_USED" });
    const talk = await resolve(connector, human);
    if (!talk.ok) throw new Error("expected the human nonce to resolve");
    expect(await consumeNonce(connector, talk.nonce)).toBe(true);
    expect(await resolve(connector, human)).toMatchObject({ ok: true });
  });

  it("refuses a loan row without its loan", () => {
    const { connector } = testConnector();
    expect(() => nonceOps(connector, { worldId: "demo", customerId: "cus-0010", phoneHash: PHONE_HASH, messageId: "m", buttons: [{ action: "CHOOSE_LOAN" }], now: TEST_NOW })).toThrow(RangeError);
  });
});
