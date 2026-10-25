import { describe, expect, it } from "vitest";
import type { CallerRole } from "./http/caller";
import { createInProcessNetworkMock } from "./testing";
import { reversalActionId, traceIdFor } from "./transfers";

const WORLD = "demo";
const NOW = "2026-10-07T10:10:00-03:00";

/** The transfers of the personas C27…C30 (docs/seed-spec.md §8). */
function setup(worldId = WORLD) {
  const mock = createInProcessNetworkMock();
  mock.seedWorld(worldId);
  mock.seedTransfer({ worldId, transferId: "trf-c27", customerId: "cus-0027", direction: "OUT", amount: 4_500_000, status: "COMPLETED", traceId: "TRZ-7F3K9Q2M", completedAtSim: "2026-10-05T14:02:00-03:00" });
  mock.seedTransfer({ worldId, transferId: "trf-c28", customerId: "cus-0028", direction: "IN", amount: 12_000_000, status: "PENDING", expectedBySim: "2026-10-08T18:00:00-03:00" });
  mock.seedTransfer({ worldId, transferId: "trf-c29", customerId: "cus-0029", direction: "OUT", amount: 3_000_000, status: "REJECTED_REVERSED", rejectReason: "CVU inexistente", reversedAtSim: "2026-10-04T10:00:00-03:00" });
  mock.seedTransfer({ worldId, transferId: "trf-c30", customerId: "cus-0030", direction: "OUT", amount: 8_000_000, status: "REJECTED_NOT_REVERSED", rejectReason: "Cuenta destino cerrada" });
  const get = (transferId: string, role: CallerRole = "ToolInvestigation", simNow = NOW) => mock.call(role, { method: "GET", path: `/v1/${worldId}/transfers/${transferId}`, simNow });
  const transition = (transferId: string, body: unknown, simNow = "2026-10-08T12:00:00-03:00") =>
    mock.call("ScheduleDispatch", { method: "POST", path: `/v1/${worldId}/transfers/${transferId}/transition`, simNow, body });
  const reverse = (transferId: string, body: Record<string, unknown> = {}, role: CallerRole = "ToolActions") =>
    mock.call(role, {
      method: "POST",
      path: `/v1/${worldId}/transfers/${transferId}/reversal-request`,
      simNow: NOW,
      body: { customerId: "cus-0030", complaintId: "cmp-0030", idempotencyKey: "cmp-0030:TRANSFER_REVERSAL:1", cap: 20_000_000, ...body },
    });
  return { mock, get, transition, reverse };
}

describe("[FL-041] completed transfer: the network's trace", () => {
  it("[FL-041] answers COMPLETED with the trace and the instant, never the customer or the amount", async () => {
    const { get } = setup();
    const response = await get("trf-c27");
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ transferId: "trf-c27", status: "COMPLETED", traceId: "TRZ-7F3K9Q2M", completedAtSim: "2026-10-05T14:02:00-03:00" });
  });

  it("answers UNKNOWN for a transfer the network never saw, and the rejection of a reversed one", async () => {
    const { get } = setup();
    expect((await get("trf-c31")).json).toEqual({ transferId: "trf-c31", status: "UNKNOWN" });
    expect((await get("trf-c29")).json).toEqual({ transferId: "trf-c29", status: "REJECTED_REVERSED", rejectReason: "CVU inexistente", reversedAtSim: "2026-10-04T10:00:00-03:00" });
  });
});

describe("[FL-042] pending transfer: the scheduled transition", () => {
  it("[FL-042] answers PENDING with the network's expected time until the NETWORK_TRANSITION timer fires", async () => {
    const { get } = setup();
    expect((await get("trf-c28")).json).toEqual({ transferId: "trf-c28", status: "PENDING", expectedBySim: "2026-10-08T18:00:00-03:00" });
  });

  it("[FL-042] moves PENDING → COMPLETED at the timer's instant with a trace, once, and records the transition", async () => {
    const { mock, get, transition } = setup();
    const done = await transition("trf-c28", { to: "COMPLETED" });
    const expected = { transferId: "trf-c28", status: "COMPLETED", traceId: traceIdFor(WORLD, "trf-c28"), completedAtSim: "2026-10-08T12:00:00-03:00", expectedBySim: "2026-10-08T18:00:00-03:00" };
    expect(done.statusCode).toBe(200);
    expect(done.json).toEqual(expected);
    expect(traceIdFor(WORLD, "trf-c28")).toMatch(/^TRZ-[0-9A-F]{10}$/);
    // A retried timer changes nothing: same answer, one transition recorded.
    expect((await transition("trf-c28", { to: "COMPLETED" }, "2026-10-08T12:05:00-03:00")).json).toEqual(expected);
    expect((await get("trf-c28", "EventWorker")).json).toEqual(expected);
    const stored = mock.store.dump().find((raw) => raw.entity === "TransferStatus" && raw.transferId === "trf-c28");
    expect(stored?.transitions).toEqual([{ from: "PENDING", to: "COMPLETED", atSim: "2026-10-08T12:00:00-03:00", by: "TRANSITION" }]);
    expect(stored?.version).toBe(2);
  });

  it("refuses an impossible transition (409) and an unknown transfer (404)", async () => {
    const { transition } = setup();
    expect((await transition("trf-c27", { to: "REJECTED_NOT_REVERSED" })).json).toMatchObject({ code: "CONFLICT" });
    expect((await transition("trf-c31", { to: "COMPLETED" })).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await transition("trf-c28", { to: "UNKNOWN" })).statusCode).toBe(400);
  });

  it("rejects with the network's reason, and a later transition can return the money", async () => {
    const { transition } = setup();
    expect((await transition("trf-c28", { to: "REJECTED_NOT_REVERSED", rejectReason: "Destino inhabilitado" })).json).toEqual({
      transferId: "trf-c28",
      status: "REJECTED_NOT_REVERSED",
      rejectReason: "Destino inhabilitado",
      expectedBySim: "2026-10-08T18:00:00-03:00",
    });
    expect((await transition("trf-c28", { to: "REJECTED_REVERSED" }, "2026-10-09T09:00:00-03:00")).json).toMatchObject({ status: "REJECTED_REVERSED", reversedAtSim: "2026-10-09T09:00:00-03:00" });
  });
});

describe("[FL-044] rejected transfer not returned: reversal once per transfer", () => {
  it("[FL-044] reverses within the cap: the network confirms, takes TRV#<transferId> and the transfer is REJECTED_REVERSED", async () => {
    const { mock, get, reverse } = setup();
    const response = await reverse("trf-c30");
    const actionId = reversalActionId(WORLD, "trf-c30", "cmp-0030:TRANSFER_REVERSAL:1");
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({ actionId, transferId: "trf-c30", status: "REJECTED_REVERSED", amount: 8_000_000, reversedAtSim: NOW });
    expect((await get("trf-c30")).json).toEqual({ transferId: "trf-c30", status: "REJECTED_REVERSED", rejectReason: "Cuenta destino cerrada", reversedAtSim: NOW });
    const claim = mock.store.dump().find((raw) => raw.entity === "TransferReversalClaim");
    expect(claim).toMatchObject({ pk: "W#demo#TRV#trf-c30", sk: "CLAIM", actionId, customerId: "cus-0030", complaintId: "cmp-0030", amount: 8_000_000 });
  });

  it("[FL-044] a second attempt (another complaint or approval) gets CONFLICT with the existing action; a retry gets the same answer", async () => {
    const { reverse } = setup();
    const first = await reverse("trf-c30");
    expect((await reverse("trf-c30")).json).toEqual(first.json);
    const second = await reverse("trf-c30", { complaintId: "cmp-0031", idempotencyKey: "cmp-0031:TRANSFER_REVERSAL:1" }, "EventWorker");
    expect(second.statusCode).toBe(409);
    expect(second.json).toMatchObject({ code: "CONFLICT", actionId: (first.json as { actionId: string }).actionId });
  });

  it("[FL-044] two reversals at the same time move the money once", async () => {
    const { mock, reverse } = setup();
    const answers = await Promise.all([reverse("trf-c30"), reverse("trf-c30", { complaintId: "cmp-0031", idempotencyKey: "cmp-0031:TRANSFER_REVERSAL:1" })]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    expect(mock.store.dump().filter((raw) => raw.entity === "TransferReversalClaim")).toHaveLength(1);
  });

  it("[FL-044] moves nothing above the cap, for another customer's transfer or for one that is not eligible", async () => {
    const { mock, reverse } = setup();
    expect((await reverse("trf-c30", { cap: 7_999_999 })).json).toMatchObject({ code: "ABOVE_CAP" });
    expect((await reverse("trf-c30", { customerId: "cus-0029" })).json).toMatchObject({ code: "FORBIDDEN" });
    expect((await reverse("trf-c29", { customerId: "cus-0029" })).json).toMatchObject({ code: "NOT_ELIGIBLE" });
    expect((await reverse("trf-c28", { customerId: "cus-0028" })).json).toMatchObject({ code: "NOT_ELIGIBLE" });
    expect((await reverse("trf-c31")).json).toMatchObject({ code: "NOT_FOUND" });
    expect((await reverse("trf-c30", { capOverride: 1 })).statusCode).toBe(400);
    expect(mock.store.dump().filter((raw) => raw.entity === "TransferReversalClaim")).toHaveLength(0);
    expect(mock.store.dump().find((raw) => raw.transferId === "trf-c30" && raw.entity === "TransferStatus")?.status).toBe("REJECTED_NOT_REVERSED");
  });
});
