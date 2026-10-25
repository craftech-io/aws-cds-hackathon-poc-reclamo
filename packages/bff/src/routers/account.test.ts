// `account.*` (docs/architecture.md §11; FL-094): the password change of a personal staff account by the
// BFF's admin calls (current password checked, recent sign-in, never a guest), and the "another
// session" notice of a shared guest account.
import { beforeEach, describe, expect, it } from "vitest";
import { GUEST, OPERATOR, SUPERVISOR, type ConsoleRig, consoleRig, refusalOf } from "./testing";

const HOUR = 60 * 60_000;
const CURRENT = "Contraseña-actual-1";
const NEXT = "Contraseña-nueva-2026";

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("demo");
  await rig.seedWorld("g03");
  rig.passwords.current.set("operator-01", CURRENT);
});

describe("account.changePassword [FL-094]", () => {
  it("[FL-094] checks the current password, sets the new one through the admin API and audits it, logging no password", async () => {
    const { caller } = await rig.as(OPERATOR);
    expect(await caller.account.changePassword({ currentPassword: CURRENT, newPassword: NEXT })).toEqual({ changed: true });
    expect(rig.passwords.current.get("operator-01")).toBe(NEXT);
    expect(await rig.connector.audit.listByAction("demo", "PASSWORD_CHANGED")).toEqual([expect.objectContaining({ actor: "OPERATOR:stf-operator-01", refs: { staffId: "stf-operator-01" } })]);
    const logged = rig.lines.join("\n");
    expect(logged).not.toContain(CURRENT);
    expect(logged).not.toContain(NEXT);
  });

  it("[FL-094] refuses a wrong current password and a password the pool's policy rejects, changing nothing", async () => {
    const { caller } = await rig.as(OPERATOR);
    expect(await refusalOf(() => caller.account.changePassword({ currentPassword: "otra-cosa-123", newPassword: NEXT }))).toBe("WRONG_PASSWORD");
    expect(await refusalOf(() => caller.account.changePassword({ currentPassword: CURRENT, newPassword: "corta-123" }))).toBe("WEAK_PASSWORD");
    expect(await refusalOf(() => caller.account.changePassword({ currentPassword: CURRENT, newPassword: CURRENT }))).toBe("BAD_REQUEST");
    expect(rig.passwords.current.get("operator-01")).toBe(CURRENT);
  });

  it("[FL-094] needs a sign-in of at most 15 minutes and is never offered to a guest", async () => {
    expect(await refusalOf(async () => (await rig.as(OPERATOR, 20 * 60)).caller.account.changePassword({ currentPassword: CURRENT, newPassword: NEXT }))).toBe("LOGIN_NOT_RECENT");
    expect(await refusalOf(async () => (await rig.as(GUEST)).caller.account.changePassword({ currentPassword: CURRENT, newPassword: NEXT }))).toBe("ROLE_NOT_ALLOWED");
    expect(await refusalOf(async () => (await rig.as(SUPERVISOR)).caller.account.changePassword({ currentPassword: CURRENT, newPassword: NEXT }))).toBe("WRONG_PASSWORD");
  });
});

describe("account.session [FL-094]", () => {
  it("[FL-094] warns a guest account of another session active in the last 2 real hours, never blocking", async () => {
    const first = (await rig.as(GUEST, 0, { origin_jti: "11111111-0000-4000-8000-000000000001" })).caller;
    expect(await first.account.session()).toEqual({ otherSessionActive: false });
    expect((await rig.connector.runtime.getClock("g03"))?.lastSession?.sessionId).toBe("11111111-0000-4000-8000-000000000001");
    const second = (await rig.as(GUEST, 0, { origin_jti: "22222222-0000-4000-8000-000000000002" })).caller;
    expect(await second.account.session()).toEqual({ otherSessionActive: true });
    rig.passReal(2 * HOUR + 1);
    expect(await first.account.session()).toEqual({ otherSessionActive: false });
  });

  it("never warns staff of a shared world and writes nothing for them", async () => {
    const { caller } = await rig.as(OPERATOR);
    expect(await caller.account.session()).toEqual({ otherSessionActive: false });
    expect((await rig.connector.runtime.getClock("demo"))?.lastSession).toBeUndefined();
  });
});
