// FL-083: a message of the customer while a complaint is answered moves its automatic closure to five
// business days after the message; an earlier instant, another status or a fired timer move nothing.
import { describe, expect, it } from "vitest";
import { complaint, timer } from "../connector/testing";
import type { ComplaintStatus } from "@reclamo/shared";
import { deferAutoClose } from "./auto-close";
import { autoCloseAt, loadHolidays } from "./sla";
import { complaintsKit } from "./testing";

const ANSWERED_DUE = "2026-10-15T15:00:00-03:00";

async function answered(status: ComplaintStatus = "ANSWERED", timerStatus: "SCHEDULED" | "FIRED" = "SCHEDULED") {
  const synced: string[] = [];
  const milestones = { schedule: async (_w: string, ids: readonly { timerId: string }[]) => void synced.push(...ids.map((id) => id.timerId)), cancel: async () => undefined };
  const kit = complaintsKit({ milestones });
  await kit.seedWorld();
  await kit.connector.transact([
    kit.connector.complaints.createOp(complaint("demo", { status })),
    kit.connector.timers.putOp(timer("demo", { kind: "AUTO_CLOSE", timerId: "cmp-0001-AUTO_CLOSE-1", dueAtSim: ANSWERED_DUE, seq: 3, status: timerStatus })),
  ]);
  const autoClose = async () => (await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001")).find((item) => item.kind === "AUTO_CLOSE");
  return { kit, synced, autoClose };
}

describe("deferAutoClose [FL-083]", () => {
  it("[FL-083] moves AUTO_CLOSE to five business days after the customer's message and resyncs the schedules", async () => {
    const { kit, synced, autoClose } = await answered();
    const atSim = "2026-10-13T10:00:00-03:00";
    expect(await deferAutoClose(kit.deps, { worldId: "demo", customerId: "cus-0001", atSim })).toBe(1);
    const moved = await autoClose();
    expect(moved).toMatchObject({ status: "SCHEDULED", dueAtSim: autoCloseAt(atSim, await loadHolidays(kit.connector)), version: 2 });
    expect(Date.parse(moved?.dueAtSim ?? "")).toBeGreaterThan(Date.parse(ANSWERED_DUE));
    expect(synced).toEqual(["cmp-0001-AUTO_CLOSE-1"]);
    // The same message again (a redelivery) changes nothing.
    expect(await deferAutoClose(kit.deps, { worldId: "demo", customerId: "cus-0001", atSim })).toBe(0);
  });

  it("[FL-083] leaves a closure that is already later, a complaint not ANSWERED and a fired timer alone", async () => {
    const early = await answered();
    expect(await deferAutoClose(early.kit.deps, { worldId: "demo", customerId: "cus-0001", atSim: "2026-10-01T10:00:00-03:00" })).toBe(0);
    expect((await early.autoClose())?.dueAtSim).toBe(ANSWERED_DUE);

    const investigating = await answered("INVESTIGATING");
    expect(await deferAutoClose(investigating.kit.deps, { worldId: "demo", customerId: "cus-0001", atSim: "2026-10-13T10:00:00-03:00" })).toBe(0);

    const fired = await answered("ANSWERED", "FIRED");
    expect(await deferAutoClose(fired.kit.deps, { worldId: "demo", customerId: "cus-0001", atSim: "2026-10-13T10:00:00-03:00" })).toBe(0);
    expect(fired.synced).toEqual([]);
  });
});
