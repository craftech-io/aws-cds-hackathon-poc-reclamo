// Policy caps and approvals (docs/design-brief.md §4, docs/architecture.md §8.5): tiers by action
// and amount, the monthly limit of automatic reversals, approvals with epoch and expiry.
import { describe, expect, it } from "vitest";
import { SIM_NOW, approval, complaint } from "../connector/testing";
import type { Approval } from "../domain/case-items";
import type { WorldCaps } from "../domain/world";
import {
  approvalExpiresAt,
  buildApproval,
  checkDecidable,
  checkExecutable,
  countAutomaticReversals,
  evaluateCap,
  isLapsed,
  recheckApproved,
  roleMayDecide,
  tierForAmount,
} from "./caps";
import { TEST_HOLIDAYS, complaintsKit } from "./testing";

const pesos = (amount: number) => amount * 100;

/** The caps of the design brief (§4), in centavos. */
const CAPS: WorldCaps = {
  perAction: {
    APPLY_PAYMENT: { agentCents: pesos(250_000), operatorCents: pesos(1_000_000) },
    REVERSE_CHARGE: { agentCents: pesos(15_000), operatorCents: pesos(150_000) },
    REFUND_DUPLICATE: { agentCents: pesos(120_000), operatorCents: pesos(600_000) },
    TRANSFER_REVERSAL: { agentCents: pesos(200_000), operatorCents: pesos(1_000_000) },
  },
  autoActionsPer30Days: 2,
};

describe("tiers by action and amount", () => {
  it("lets the agent act up to its cap, an operator approve up to theirs and a supervisor above", () => {
    expect(evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(118_640), caps: CAPS, automaticReversalsIn30Days: 0 })).toMatchObject({ tier: "AGENT", reason: "WITHIN_AGENT_CAP" });
    expect(evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(250_000), caps: CAPS, automaticReversalsIn30Days: 0 }).tier).toBe("AGENT");
    expect(evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(250_000) + 1, caps: CAPS, automaticReversalsIn30Days: 0 })).toMatchObject({ tier: "OPERATOR", reason: "AMOUNT_ABOVE_AGENT_CAP" });
    expect(evaluateCap({ action: "REVERSE_CHARGE", amountCents: pesos(150_001), caps: CAPS, automaticReversalsIn30Days: 0 }).tier).toBe("SUPERVISOR");
    expect(evaluateCap({ action: "REFUND_DUPLICATE", amountCents: pesos(118_640), caps: CAPS, automaticReversalsIn30Days: 0 }).tier).toBe("AGENT");
    expect(evaluateCap({ action: "TRANSFER_REVERSAL", amountCents: pesos(600_000), caps: CAPS, automaticReversalsIn30Days: 0 }).tier).toBe("OPERATOR");
  });

  it("refuses an amount that is not a whole number of centavos", () => {
    expect(() => tierForAmount(CAPS.perAction.APPLY_PAYMENT as never, 10.5)).toThrow();
    expect(() => tierForAmount(CAPS.perAction.APPLY_PAYMENT as never, -1)).toThrow();
  });
});

describe("monthly limit of automatic reversals [FL-040]", () => {
  it("[FL-040] the third reversal or refund of the customer in 30 days needs an operator even when it is small", () => {
    expect(evaluateCap({ action: "REVERSE_CHARGE", amountCents: pesos(1_200), caps: CAPS, automaticReversalsIn30Days: 1 }).tier).toBe("AGENT");
    expect(evaluateCap({ action: "REVERSE_CHARGE", amountCents: pesos(1_200), caps: CAPS, automaticReversalsIn30Days: 2 })).toMatchObject({ tier: "OPERATOR", reason: "MONTHLY_AUTO_LIMIT" });
    expect(evaluateCap({ action: "REFUND_DUPLICATE", amountCents: pesos(5_000), caps: CAPS, automaticReversalsIn30Days: 2 }).reason).toBe("MONTHLY_AUTO_LIMIT");
    // A payment allocation is not a reversal: the monthly limit does not apply.
    expect(evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(5_000), caps: CAPS, automaticReversalsIn30Days: 9 }).tier).toBe("AGENT");
    // Above the operator cap it stays a supervisor's, whatever the count.
    expect(evaluateCap({ action: "REVERSE_CHARGE", amountCents: pesos(200_000), caps: CAPS, automaticReversalsIn30Days: 5 }).tier).toBe("SUPERVISOR");
  });

  it("[FL-040] counts only the agent's own executed reversals and refunds of the last 30 simulated days", async () => {
    const kit = complaintsKit();
    const { connector } = kit;
    await connector.transact([
      connector.complaints.createOp(complaint("demo", { complaintId: "cmp-a", customerId: "cus-0002", complaintNumber: "R-2026-000101" })),
      connector.complaints.createOp(complaint("demo", { complaintId: "cmp-b", customerId: "cus-0002", complaintNumber: "R-2026-000102" })),
      connector.complaints.createOp(complaint("demo", { complaintId: "cmp-c", customerId: "cus-0003", complaintNumber: "R-2026-000103" })),
    ]);
    const action = (complaintId: string, actionId: string, overrides: Record<string, unknown>) =>
      connector.caseItems.putActionOp({ worldId: "demo", complaintId, actionId, kind: "REVERSE_CHARGE", status: "EXECUTED", amountCents: 120_000, idempotencyKey: actionId, atSim: "2026-10-01T10:00:00-03:00", actor: "AGENT", ...overrides });
    await connector.transact([
      action("cmp-a", "act-1", {}),
      action("cmp-b", "act-2", { kind: "REFUND_DUPLICATE", atSim: "2026-09-20T10:00:00-03:00" }),
      action("cmp-b", "act-3", { atSim: "2026-09-01T10:00:00-03:00" }),
      action("cmp-b", "act-4", { approvalId: "apr-1" }),
      action("cmp-b", "act-5", { status: "CONFLICT" }),
      action("cmp-b", "act-6", { kind: "APPLY_PAYMENT" }),
      action("cmp-c", "act-7", {}),
    ]);
    expect(await countAutomaticReversals(connector, { worldId: "demo", customerId: "cus-0002", simNow: SIM_NOW })).toBe(2);
    expect(await countAutomaticReversals(connector, { worldId: "demo", customerId: "cus-0003", simNow: SIM_NOW })).toBe(1);
  });
});

describe("approvals with epoch and expiry", () => {
  const requested = (overrides: Partial<Approval> = {}): Approval => ({ ...approval("demo"), version: 1, ...overrides }) as Approval;

  it("expires two simulated business days after the request, skipping weekends and holidays", () => {
    expect(approvalExpiresAt(SIM_NOW, TEST_HOLIDAYS)).toBe("2026-10-09T10:10:00-03:00");
    expect(approvalExpiresAt("2026-10-09T16:00:00-03:00", TEST_HOLIDAYS)).toBe("2026-10-14T16:00:00-03:00");
  });

  it("builds a PENDING approval with the tier and amount the code fixed, never one within the agent cap", () => {
    const decision = evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(300_000), caps: CAPS, automaticReversalsIn30Days: 0 });
    const built = buildApproval({ worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-1", evidenceId: "evd-1", justification: "x".repeat(600), decision, epoch: 3, requestedAtSim: SIM_NOW, holidays: TEST_HOLIDAYS });
    expect(built).toMatchObject({ action: "APPLY_PAYMENT", amountCents: pesos(300_000), capTier: "OPERATOR", requestedBy: "AGENT", epoch: 3, expiresAtSim: "2026-10-09T10:10:00-03:00" });
    expect(built.justification).toHaveLength(500);
    const agent = evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(1_000), caps: CAPS, automaticReversalsIn30Days: 0 });
    expect(() => buildApproval({ worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-2", evidenceId: "evd-1", justification: "", decision: agent, epoch: 1, requestedAtSim: SIM_NOW, holidays: [] })).toThrow();
  });

  it("is decided by an operator up to the operator tier and by a supervisor above, while pending, current and in its epoch", () => {
    expect(roleMayDecide("OPERATOR", "OPERATOR")).toBe(true);
    expect(roleMayDecide("OPERATOR", "SUPERVISOR")).toBe(false);
    expect(roleMayDecide("SUPERVISOR", "SUPERVISOR")).toBe(true);
    expect(roleMayDecide("COMPLIANCE", "OPERATOR")).toBe(false);
    expect(roleMayDecide("GUEST", "OPERATOR")).toBe(false);
    const now = { epoch: 1, simNow: SIM_NOW };
    expect(checkDecidable(requested(), { ...now, role: "OPERATOR" })).toEqual({ ok: true });
    expect(checkDecidable(requested({ capTier: "SUPERVISOR" }), { ...now, role: "OPERATOR" })).toEqual({ ok: false, block: "ROLE_BELOW_TIER" });
    expect(checkDecidable(requested({ decision: "REJECTED" }), { ...now, role: "SUPERVISOR" })).toEqual({ ok: false, block: "NOT_PENDING" });
    expect(checkDecidable(requested(), { ...now, epoch: 2, role: "SUPERVISOR" })).toEqual({ ok: false, block: "OTHER_EPOCH" });
    expect(checkDecidable(requested(), { epoch: 1, simNow: "2026-10-09T10:10:00-03:00", role: "SUPERVISOR" })).toEqual({ ok: false, block: "EXPIRED" });
    expect(isLapsed(requested(), { epoch: 1, simNow: "2026-10-10T00:00:00-03:00" })).toBe(true);
    expect(isLapsed(requested(), { epoch: 1, simNow: SIM_NOW })).toBe(false);
  });

  it("executes only an approved, staff-decided, unexecuted approval of the current epoch before it expires", () => {
    const approved = requested({ decision: "APPROVED", decidedBy: "stf-operator-01", decidedAtSim: SIM_NOW });
    const now = { epoch: 1, simNow: "2026-10-08T09:00:00-03:00" };
    expect(checkExecutable(approved, now)).toEqual({ ok: true });
    expect(checkExecutable(requested(), now)).toEqual({ ok: false, block: "NOT_APPROVED" });
    expect(checkExecutable(requested({ decision: "APPROVED" }), now)).toEqual({ ok: false, block: "NOT_DECIDED_BY_STAFF" });
    expect(checkExecutable({ ...approved, executedAt: "2026-10-07T13:20:00.000Z" }, now)).toEqual({ ok: false, block: "ALREADY_EXECUTED" });
    expect(checkExecutable(approved, { ...now, epoch: 2 })).toEqual({ ok: false, block: "OTHER_EPOCH" });
    expect(checkExecutable(approved, { epoch: 1, simNow: "2026-10-09T10:10:00-03:00" })).toEqual({ ok: false, block: "EXPIRED" });
  });

  it("sends the execution to a person when the recomputed amount grew or the tier changed", () => {
    const approved = requested({ decision: "APPROVED", decidedBy: "stf-operator-01", amountCents: pesos(300_000), capTier: "OPERATOR" });
    const same = evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(300_000), caps: CAPS, automaticReversalsIn30Days: 0 });
    expect(recheckApproved(approved, same)).toEqual({ ok: true });
    expect(recheckApproved(approved, evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(300_001), caps: CAPS, automaticReversalsIn30Days: 0 }))).toEqual({ ok: false, reason: "AMOUNT_GREW" });
    const lowerCaps: WorldCaps = { ...CAPS, perAction: { ...CAPS.perAction, APPLY_PAYMENT: { agentCents: pesos(1_000), operatorCents: pesos(200_000) } } };
    expect(recheckApproved(approved, evaluateCap({ action: "APPLY_PAYMENT", amountCents: pesos(300_000), caps: lowerCaps, automaticReversalsIn30Days: 0 }))).toEqual({ ok: false, reason: "TIER_CHANGED" });
    expect(recheckApproved(approved, evaluateCap({ action: "REVERSE_CHARGE", amountCents: pesos(1_000), caps: CAPS, automaticReversalsIn30Days: 0 }))).toEqual({ ok: false, reason: "ACTION_CHANGED" });
  });
});
