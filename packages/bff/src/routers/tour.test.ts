// `tour.*` (docs/design-brief.md §15; FL-101, FL-082, FL-100): the guided tour's server side. `steps`
// checks the world is pristine (clock at Wed 07/10 10:10, no complaint of C01) and fills the dates of
// "Qué mirar" from the clock; `run` drives each button through the same procedures as the views.
import { beforeEach, describe, expect, it } from "vitest";
import { addressHash } from "@reclamo/shared";
import { TourSteps } from "../../../web/src/lib/world-clock";
import { TEST_PHONE_KEY } from "../channels/whatsapp/testing";
import { complaint, message, timer } from "../connector/testing";
import { personaPhone } from "./simulator";
import { COMPLIANCE, type ConsoleRig, GUEST, OPERATOR, consoleRig, refusalOf } from "./testing";
import { TOUR_BLOCKS, TOUR_START_SIM } from "./tour";

let rig: ConsoleRig;

beforeEach(async () => {
  rig = consoleRig();
  await rig.seedWorld("g03");
  await rig.connector.timers.put(timer("g03", { kind: "SETTLEMENT_PUBLISH", timerId: "norte-2026-10-08", dueAtSim: "2026-10-08T08:30:00-03:00", ownerKey: "BATCH#NORTE#2026-10-08", payload: { network: "NORTE", businessDate: "2026-10-08" } }));
});

describe("tour.steps", () => {
  it("[FL-101] says a fresh world is pristine and gives the clock, the next events and the time budget of each block", async () => {
    const { caller } = await rig.as(GUEST);
    const steps = await caller.tour.steps();
    expect(steps).toMatchObject({ worldId: "g03", simNow: TOUR_START_SIM, mode: "PAUSED", pristine: { ok: true, clockAtStart: true, mainStoryFiled: false }, mainStory: null, measured: false });
    expect(steps.nextEvents).toEqual([expect.objectContaining({ kind: "SETTLEMENT_PUBLISH", dueAtSim: "2026-10-08T08:30:00-03:00" })]);
    expect(steps.blocks.map((block) => [block.block, block.budgetSeconds])).toEqual([["QUICK", 300], ["DEEP", 900]]);
    for (const block of TOUR_BLOCKS) expect(block.steps.reduce((sum, [, seconds]) => sum + seconds, 0)).toBeLessThanOrEqual(block.budgetSeconds);
    // "Tu recorrido: ~X min" of the console's panel: the 5-minute block first.
    expect(TourSteps.parse(steps).totalMinutes).toBe(5);
  });

  it("[FL-101] is no longer pristine once C01 filed its complaint or the clock moved, and shows the main story", async () => {
    await rig.connector.transact([rig.connector.complaints.createOp(complaint("g03", { complaintId: "cmp-0123", origin: "LIVE", deadlineSim: "2026-10-22T23:59:59-03:00" }))]);
    const { caller } = await rig.as(GUEST);
    const steps = await caller.tour.steps();
    expect(steps.pristine).toEqual({ ok: false, clockAtStart: true, mainStoryFiled: true });
    expect(steps.mainStory).toMatchObject({ complaintId: "cmp-0123", complaintNumber: "R-2026-000123", deadlineSim: "2026-10-22T23:59:59-03:00" });
    expect(steps.totalMinutes).toBe(15);
  });

  it("[FL-100] answers nothing while the world is being reset; the console waits on clock.resetStatus", async () => {
    await (await rig.as(GUEST)).caller.clock.reset();
    expect(await refusalOf(async () => (await rig.as(GUEST)).caller.tour.steps())).toBe("WORLD_RESETTING");
  });
});

describe("tour.run", () => {
  it("[FL-101] sends the persona's script message and its synthetic receipt through the simulator", async () => {
    const { caller } = await rig.as(GUEST);
    const result = await caller.tour.run({ action: { kind: "sendScript", persona: "C01" } });
    expect(result).toMatchObject({ kind: "sendScript", sent: [expect.objectContaining({ accepted: true }), expect.objectContaining({ accepted: true })] });
    expect(rig.delivered).toHaveLength(2);
    expect(rig.intake.intake.map((message) => message.customerId)).toEqual(["cus-0001", "cus-0001"]);
  });

  it("[FL-082] advances to the next event, or to the next milestone of a complaint by its number", async () => {
    await rig.connector.transact([rig.connector.complaints.createOp(complaint("g03", { complaintId: "cmp-0123" }))]);
    await rig.connector.timers.put(timer("g03", { kind: "FOLLOW_UP", timerId: "f-1", dueAtSim: "2026-10-07T12:00:00-03:00", ownerKey: "CMP#cmp-0123", payload: { complaintId: "cmp-0123", customerId: "cus-0001" } }));
    const { caller } = await rig.as(GUEST);
    const byNumber = await caller.tour.run({ action: { kind: "advanceToNext", complaintNumber: "R-2026-000123" } });
    expect(byNumber).toMatchObject({ moved: { simNow: "2026-10-07T12:00:00-03:00" } });
    expect(await refusalOf(() => caller.tour.run({ action: { kind: "advanceToNext", complaintNumber: "R-2026-999999" } }))).toBe("COMPLAINT_NOT_FOUND");
  });

  it("[FL-101] taps the button that the latest message offers, by its action", async () => {
    const { caller } = await rig.as(GUEST);
    expect(await refusalOf(() => caller.tour.run({ action: { kind: "tapButton", persona: "C01", action: "ACCEPT_EMAIL" } }))).toBe("TOUR_BUTTON_NOT_FOUND");
    const phoneHash = await addressHash("WHATSAPP", personaPhone("C01"), TEST_PHONE_KEY);
    await rig.connector.write(rig.connector.claims.putNonceOp({ worldId: "g03", nonce: "nonce-accept-0002", action: "ACCEPT_EMAIL", phoneHash, customerId: "cus-0001", createdAtReal: rig.now().toISOString() }));
    await rig.connector.conversations.putMessage(
      message("g03", { messageId: "msg-ack", direction: "OUT", body: "Tu reclamo es R-2026-000123.", status: "DELIVERED", providerMessageId: "wamid.SIM.01ACK", interactive: { shape: "buttons", buttons: [{ action: "ACCEPT_EMAIL", nonce: "nonce-accept-0002", title: "Sí, a ese email" }] } }),
    );
    expect(await caller.tour.run({ action: { kind: "tapButton", persona: "C01", action: "ACCEPT_EMAIL" } })).toMatchObject({ sent: [expect.objectContaining({ accepted: true })] });
    expect(rig.intake.effects).toEqual([expect.objectContaining({ kind: "EMAIL_CONSENT" })]);
  });

  it("starts the live clock and exports the register like the views do", async () => {
    await rig.seedWorld("demo");
    const { caller } = await rig.as(OPERATOR);
    expect(await caller.tour.run({ action: { kind: "setRunning", rate: 288 } })).toMatchObject({ clock: { mode: "RUNNING", rate: 288 } });
    expect(await caller.tour.run({ action: { kind: "exportRegister" } })).toMatchObject({ export: { chain: "REG", result: "ok" } });
  });

  it("keeps the read-only role and unknown actions out", async () => {
    await rig.seedWorld("demo");
    const { caller } = await rig.as(COMPLIANCE);
    expect(await refusalOf(() => caller.tour.run({ action: { kind: "exportRegister" } }))).toBe("READ_ONLY_ROLE");
    const guest = (await rig.as(GUEST)).caller;
    await expect(guest.tour.run({ action: { kind: "deleteWorld" } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
