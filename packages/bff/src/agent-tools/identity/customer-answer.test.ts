import { describe, expect, it } from "vitest";
import { CHALLENGE_PROMPT, WHATSAPP_TEXT } from "../../copy";
import type { ToolResponse } from "../common/context";
import { OTHER_CUSTOMER } from "../common/testing";
import { CUSTOMER, WORLD, codeOf, okOf } from "../account/testing";
import { ANSWER_REFUSAL } from "./customer-answer";
import { identityKit } from "./testing";

function reasonOf(response: ToolResponse): string | undefined {
  if (response.ok) throw new Error(`expected a refusal, got ${JSON.stringify(response)}`);
  return response.error.reason;
}

/** Nothing moved: no failure counted, not identified, the account still closed. */
async function untouched(setup: Awaited<ReturnType<typeof identityKit>>, token: string): Promise<void> {
  expect(await setup.kit.connector.caps.getChallenge(WORLD, CUSTOMER)).toBeUndefined();
  expect((await setup.kit.connector.conversations.getMeta(WORLD, CUSTOMER))?.identifiedUntilReal).toBeUndefined();
  expect(codeOf(await setup.getAccount(token))).toBe("NOT_IDENTIFIED");
}

describe("[FL-003] verify_challenge only takes the customer's own answer", () => {
  it("[FL-003] refuses the model's own value when the customer only greeted (the turn that asked cannot verify)", async () => {
    const setup = await identityKit();
    await setup.wrote("hola");
    const turn = await setup.kit.openTurn();
    // Before the challenge went out, nothing is an answer.
    expect(reasonOf(await setup.verify(turn.token, "5/10"))).toBe(ANSWER_REFUSAL.NOT_ASKED);
    // Asked in this very turn: "hola" came before it, so "5/10" (the real due date) is the model's.
    await setup.asked();
    const refused = await setup.verify(turn.token, "5/10");
    expect(codeOf(refused)).toBe("INVALID");
    expect(reasonOf(refused)).toBe(ANSWER_REFUSAL.NOT_WRITTEN);
    await untouched(setup, turn.token);
    const audit = (await setup.kit.auditRows()).filter((row) => row.action === "CHALLENGE_ANSWER_REFUSED");
    expect(audit.map((row) => row.outcome)).toEqual([ANSWER_REFUSAL.NOT_ASKED, ANSWER_REFUSAL.NOT_WRITTEN]);
    expect(JSON.stringify(audit)).not.toContain("5/10");
  });

  it("[FL-003] refuses an answer copied from the challenge prompt or invented after an unrelated reply", async () => {
    const setup = await identityKit();
    const turn = await setup.answered("¿Por qué me piden eso?");
    const prompt = WHATSAPP_TEXT[CHALLENGE_PROMPT.LAST_DUE_DATE];
    expect(codeOf(await setup.verify(turn.token, prompt))).toBe("INVALID");
    for (const answer of [prompt.slice(-40), "con día y mes (dd/mm)", "dd/mm", "5/10", "05/10/2026"]) {
      expect(reasonOf(await setup.verify(turn.token, answer)), answer).toBe(ANSWER_REFUSAL.NOT_WRITTEN);
    }
    await untouched(setup, turn.token);
  });

  it("[FL-003] accepts the customer's real answer once: a checked reply never identifies again", async () => {
    const setup = await identityKit();
    const turn = await setup.answered("Me vence el 05/10");
    expect(okOf(await setup.verify(turn.token, "5/10"))).toMatchObject({ result: "OK" });
    expect((await setup.kit.auditRows()).find((row) => row.action === "IDENTIFIED")?.refs).toMatchObject({ messageId: "msg-in-0002" });

    // Past the 30 real minutes, the same reply is spent: the challenge has to be asked and answered again.
    setup.kit.advanceReal(31 * 60_000);
    const later = await setup.kit.openTurn();
    expect(reasonOf(await setup.verify(later.token, "5/10"))).toBe(ANSWER_REFUSAL.ALREADY_USED);
    expect(codeOf(await setup.getAccount(later.token))).toBe("NOT_IDENTIFIED");
    const again = await setup.answered("5/10");
    expect(okOf(await setup.verify(again.token, "5/10"))).toMatchObject({ result: "OK" });
  });

  it("[FL-003] a wrong answer of the customer counts once, never twice for the same reply", async () => {
    const setup = await identityKit();
    const turn = await setup.answered("4/10");
    expect(okOf(await setup.verify(turn.token, "4/10"))).toMatchObject({ result: "FAILED", attemptsLeft: 1 });
    expect(reasonOf(await setup.verify(turn.token, "4/10"))).toBe(ANSWER_REFUSAL.ALREADY_USED);
    expect((await setup.kit.connector.caps.getChallenge(WORLD, CUSTOMER))?.failures).toHaveLength(1);
  });

  it("[FL-003] the core compares the customer's fragment, not the model's string", async () => {
    const setup = await identityKit();
    // The customer wrote the wrong year; the model dropping it does not make it right.
    const turn = await setup.answered("05/10/2025");
    expect(okOf(await setup.verify(turn.token, "5/10"))).toMatchObject({ result: "FAILED" });
  });

  it("[FL-003] reads only replies after the latest challenge that went out, written before the turn opened, by this customer", async () => {
    const setup = await identityKit();
    // A reply that arrives while the turn runs: the turn never saw it.
    await setup.asked();
    const turn = await setup.kit.openTurn();
    await setup.wrote("5/10");
    expect(reasonOf(await setup.verify(turn.token, "5/10"))).toBe(ANSWER_REFUSAL.NOT_WRITTEN);

    // A challenge sent again after the reply starts over.
    const asked = await identityKit();
    await asked.asked();
    await asked.wrote("5/10");
    await asked.asked();
    expect(reasonOf(await asked.verify((await asked.kit.openTurn()).token, "5/10"))).toBe(ANSWER_REFUSAL.NOT_WRITTEN);

    // A challenge the gate blocked never reached the customer.
    const blocked = await identityKit();
    await blocked.asked({ status: "BLOCKED" });
    await blocked.wrote("5/10");
    expect(reasonOf(await blocked.verify((await blocked.kit.openTurn()).token, "5/10"))).toBe(ANSWER_REFUSAL.NOT_ASKED);

    // Another customer's words are not this customer's answer.
    const other = await identityKit();
    await other.asked();
    await other.asked({ customerId: OTHER_CUSTOMER });
    await other.wrote("5/10", OTHER_CUSTOMER);
    expect(reasonOf(await other.verify((await other.kit.openTurn()).token, "5/10"))).toBe(ANSWER_REFUSAL.NOT_WRITTEN);
  });
});
