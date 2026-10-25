import { describe, expect, it } from "vitest";
import { gatewayContext } from "../common/principal";
import { workerCaller } from "../common/testing";
import { CUSTOMER, TEST_NOW, WORLD, codeOf, okOf } from "../account/testing";
import { challengeKindFor, standingOf } from "./challenge";
import { identityKit as setup } from "./testing";

describe("[FL-003] identity challenge passed", () => {
  it("[FL-003] asks the due date of the last instalment due, identifies for 30 real minutes and moves the REGISTERED complaint to INVESTIGATING", async () => {
    const { kit, identify, verify, getAccount, answered } = await setup();
    const complaint = await kit.addComplaint();
    const first = await kit.openTurn({ complaintIds: [complaint.complaintId] });

    expect(codeOf(await getAccount(first.token))).toBe("NOT_IDENTIFIED");
    const asked = okOf(await identify(first.token));
    expect(asked).toMatchObject({ status: "NEEDS_CHALLENGE", firstName: "Valeria", attemptsLeft: 2, challenge: { kind: "LAST_DUE_DATE" } });
    expect(String((asked["challenge"] as { promptText: string }).promptText)).toContain("fecha de vencimiento de tu última cuota");

    const turn = await answered("Es el 5/10", { complaintIds: [complaint.complaintId] });
    expect(okOf(await verify(turn.token, "5/10"))).toMatchObject({ result: "OK", attemptsLeft: 2 });
    const meta = await kit.connector.conversations.getMeta(WORLD, CUSTOMER);
    // The customer answered two phone pauses after the fixed real start.
    expect(meta?.identifiedUntilReal).toBe(new Date(TEST_NOW.getTime() + 2_000 + 30 * 60_000).toISOString());
    expect(await kit.connector.caps.getChallenge(WORLD, CUSTOMER)).toBeUndefined();
    const after = await kit.connector.complaints.get(WORLD, complaint.complaintId);
    expect(after?.status).toBe("INVESTIGATING");
    expect(after?.statusHistory.at(-1)).toMatchObject({ from: "REGISTERED", to: "INVESTIGATING", cause: "IDENTIFIED" });
    expect((await kit.auditRows()).find((row) => row.action === "IDENTIFIED")).toMatchObject({ actor: "AGENT", outcome: "OK" });
    expect(okOf(await getAccount(turn.token))).toMatchObject({ account: { status: "ACTIVE" } });
    expect(okOf(await identify(turn.token))).toMatchObject({ status: "IDENTIFIED" });
  });

  it("[FL-003] the identification lasts 30 REAL minutes, whatever the world clock says", async () => {
    const { kit, identify, verify, getAccount, answered } = await setup();
    const turn = await answered("05-10-2026");
    okOf(await verify(turn.token, "05-10-2026"));
    kit.advanceReal(29 * 60_000);
    const next = await kit.openTurn();
    expect(okOf(await getAccount(next.token))).toHaveProperty("wallet");
    kit.advanceReal(2 * 60_000);
    const late = await kit.openTurn();
    expect(codeOf(await getAccount(late.token))).toBe("NOT_IDENTIFIED");
    expect(okOf(await identify(late.token))).toMatchObject({ status: "NEEDS_CHALLENGE" });
  });

  it("[FL-003] never asks the instalment amount while a complaint of the session carries a receipt, and asks the last wallet movement of a customer without loans", async () => {
    expect(challengeKindFor({ instalmentDue: true, walletMovement: true, receiptAttached: true })).toBe("LAST_DUE_DATE");
    expect(challengeKindFor({ instalmentDue: false, walletMovement: true, receiptAttached: false })).toBe("LAST_MOVEMENT_AMOUNT");
    expect(challengeKindFor({ instalmentDue: false, walletMovement: false, receiptAttached: false })).toBeUndefined();
    for (const receiptAttached of [true, false]) expect(challengeKindFor({ instalmentDue: true, walletMovement: false, receiptAttached })).not.toBe("LAST_INSTALMENT_AMOUNT");

    const { kit, identify, verify, answered } = await setup({ customerId: CUSTOMER, balance: 300_000, movements: [{ movementId: "mov-1", kind: "TRANSFER_IN", atSim: "2026-10-01T10:00:00-03:00", amount: 4_500_000 }] });
    const complaint = await kit.addComplaint();
    await kit.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-img", kind: "RECEIPT_IMAGE", details: {} });
    const first = await kit.openTurn({ complaintIds: [complaint.complaintId] });
    expect(okOf(await identify(first.token))).toMatchObject({ challenge: { kind: "LAST_MOVEMENT_AMOUNT" } });
    const turn = await answered("fueron $ 45.000", { complaintIds: [complaint.complaintId] });
    expect(okOf(await verify(turn.token, "$ 45.000"))).toMatchObject({ result: "OK" });
  });

  it("[FL-003] lets the worker preload identify_customer but never verify a challenge, and refuses extra keys or long answers", async () => {
    const { kit, identity, verify, answered } = await setup();
    const turn = await answered("5/10");
    expect(okOf(await identity.invoke("identify_customer", { sessionToken: turn.token }, workerCaller()))).toMatchObject({ status: "NEEDS_CHALLENGE" });
    expect(codeOf(await identity.invoke("verify_challenge", { sessionToken: turn.token, answer: "5/10" }, workerCaller()))).toBe("FORBIDDEN");
    expect(codeOf(await identity.handle({ sessionToken: turn.token, answer: "5/10", customerId: "cus-0002" }, gatewayContext("identity___verify_challenge")))).toBe("INVALID");
    expect(codeOf(await verify(turn.token, "x".repeat(41)))).toBe("INVALID");
    expect(await kit.connector.caps.getChallenge(WORLD, CUSTOMER)).toBeUndefined();
  });
});

describe("[FL-004] two failed challenges: a person verifies", () => {
  it("[FL-004] counts the first failure, locks on the second and hands every open complaint over (IDENTITY_VERIFICATION) by code", async () => {
    const { kit, identify, verify, getAccount, answered } = await setup();
    const complaint = await kit.addComplaint();
    const firstTurn = await answered("4/10", { complaintIds: [complaint.complaintId] });

    const first = okOf(await verify(firstTurn.token, "4/10"));
    expect(first).toMatchObject({ result: "FAILED", attemptsLeft: 1 });
    expect(okOf(await identify(firstTurn.token))).toMatchObject({ status: "NEEDS_CHALLENGE", attemptsLeft: 1 });
    const turn = await answered("creo que el 6 de octubre", { complaintIds: [complaint.complaintId] });
    const second = okOf(await verify(turn.token, "6 de octubre"));
    expect(second).toMatchObject({ result: "LOCKED", attemptsLeft: 0 });

    const after = await kit.connector.complaints.get(WORLD, complaint.complaintId);
    expect(after).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "IDENTITY_VERIFICATION" } });
    expect(kit.gate.requests).toHaveLength(1);
    expect(kit.gate.requests[0]).toMatchObject({ sender: "SYSTEM", channel: "WHATSAPP", kind: "HANDOFF_NOTICE", complaintId: complaint.complaintId, customerId: CUSTOMER });
    expect(kit.gate.requests[0]?.text).toContain(complaint.complaintNumber);
    expect(second["handoffNoticeMessageId"]).toBe(kit.gate.requests[0]?.messageId);
    const actions = (await kit.auditRows()).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["CHALLENGE_FAILED", "CHALLENGE_LOCKED"]));
    expect(codeOf(await getAccount(turn.token))).toBe("NOT_IDENTIFIED");
    // The expected value never travels: neither the due date nor the amount appear in any answer.
    expect(JSON.stringify([first, second])).not.toMatch(/05\/10|118\.640/);
  });

  it("[FL-004] a complaint an earlier escalation already gave a person takes the code's reason, IDENTITY_VERIFICATION, on the lock", async () => {
    const { kit, verify, answered } = await setup();
    const complaint = await kit.addComplaint({ status: "HUMAN_REVIEW", handoff: { reason: "LOW_CONFIDENCE", atSim: "2026-10-07T10:00:00-03:00", summary: "Se espera la respuesta del cliente." } });
    expect(okOf(await verify((await answered("4/10", { complaintIds: [complaint.complaintId] })).token, "4/10"))).toMatchObject({ result: "FAILED" });
    expect(okOf(await verify((await answered("6 de octubre", { complaintIds: [complaint.complaintId] })).token, "6 de octubre"))).toMatchObject({ result: "LOCKED" });
    expect(await kit.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "IDENTITY_VERIFICATION" } });
  });

  it("[FL-004] a new session, a new complaint or a moved world clock do not reset the count; the lock holds until staff lifts it", async () => {
    const { kit, identify, verify, answered } = await setup();
    okOf(await verify((await answered("1/1")).token, "1/1"));
    await kit.addComplaint({ complaintId: "cmp-new", complaintNumber: "R-2026-000200" });
    const fresh = await answered("2/2", { complaintIds: ["cmp-new"], eventId: "evt-other-epoch" });
    expect(okOf(await identify(fresh.token))).toMatchObject({ attemptsLeft: 1 });
    expect(okOf(await verify(fresh.token, "2/2"))).toMatchObject({ result: "LOCKED" });

    kit.advanceReal(25 * 60 * 60_000);
    const later = await kit.openTurn();
    expect(okOf(await identify(later.token))).toMatchObject({ status: "LOCKED", attemptsLeft: 0 });
    expect(okOf(await verify(later.token, "5/10"))).toMatchObject({ result: "LOCKED" });
    expect(kit.gate.requests).toHaveLength(1);

    await kit.connector.caps.clearChallenge(WORLD, CUSTOMER);
    expect(okOf(await identify((await kit.openTurn()).token))).toMatchObject({ status: "NEEDS_CHALLENGE", attemptsLeft: 2 });
  });

  it("[FL-004] failures older than 24 real hours do not count", () => {
    const now = new Date("2026-10-08T13:10:00.000Z");
    const ledger = { worldId: WORLD, customerId: CUSTOMER, failures: ["2026-10-07T13:00:00.000Z", "2026-10-08T12:00:00.000Z"], createdAt: now.toISOString(), updatedAt: now.toISOString() };
    expect(standingOf(ledger, now)).toEqual({ failures: 1, locked: false, attemptsLeft: 1 });
    expect(standingOf({ ...ledger, lockedAtReal: "2026-10-01T00:00:00.000Z" }, now)).toMatchObject({ locked: true, attemptsLeft: 0 });
  });

  it("[FL-004] a lock without an open complaint leaves a human task on the conversation and the fixed notice", async () => {
    const { kit, verify, answered } = await setup();
    okOf(await verify((await answered("1/1")).token, "1/1"));
    okOf(await verify((await answered("2/2")).token, "2/2"));
    expect(await kit.connector.conversations.listTasks(WORLD, CUSTOMER)).toHaveLength(1);
    expect(kit.gate.requests[0]).toMatchObject({ kind: "HANDOFF_NOTICE", sender: "SYSTEM" });
    expect(kit.gate.requests[0]?.complaintId).toBeUndefined();
  });
});
