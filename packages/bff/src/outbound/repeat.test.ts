// Step 0 of the gate (ADR-0021 §9, FL-106): the same WhatsApp asked twice in one turn answers the
// message already sent, evaluates nothing, writes no tape entry, calls no transport and audits
// `OUTBOUND_REPLAYED` with the original message id. Another text or another turn goes through the gate.
import { describe, expect, it } from "vitest";
import { message } from "../connector/testing";
import type { Message } from "../domain/conversation";
import { DISCLOSURE_PREFIX } from "./render/disclosure";
import { repeatedInTurn } from "./repeat";
import { VALERIA, agentTurn, call, customerWrote, gateRig, request, tapeOf } from "./testing";
import { GATE_AUDIT } from "./types";

const WROTE = "2026-10-07T10:05:00-03:00";

function out(overrides: Partial<Message>): Message {
  return { ...message("demo", { direction: "OUT", channel: "WHATSAPP", kind: "REPLY", sender: "AGENT", status: "SENT", turnId: "trn-0001", body: "Ya lo estoy revisando.", flags: {}, ...overrides }), createdAt: WROTE, updatedAt: WROTE, version: 1 } as Message;
}

describe("repeated WhatsApp in the turn: the comparison [FL-106]", () => {
  it("finds the outbound of the same turn with the same text [FL-106]", () => {
    const sent = out({ messageId: "msg-0001" });
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", text: "Ya lo estoy revisando." }, [sent])?.messageId).toBe("msg-0001");
  });

  it("compares the text the sender wrote, without the disclosure line the gate put first [FL-106]", () => {
    const sent = out({ messageId: "msg-0001", body: `${DISCLOSURE_PREFIX}Ya lo estoy revisando.`, flags: { disclosure: true } });
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", text: "Ya lo estoy revisando." }, [sent])?.messageId).toBe("msg-0001");
  });

  it("finds the same template with the same parameters, in order [FL-106]", () => {
    const sent = out({ messageId: "msg-0002", kind: "COMPLAINT_UPDATE", templateName: "reclamo_novedad", templateParams: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"], body: "Hola Valeria, …" });
    const same = { channel: "WHATSAPP" as const, turnId: "trn-0001", template: { name: "reclamo_novedad" as const, params: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"] } };
    expect(repeatedInTurn(same, [sent])?.messageId).toBe("msg-0002");
    expect(repeatedInTurn({ ...same, template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "HUMAN_REVIEWED"] } }, [sent])).toBeUndefined();
  });

  it("lets through another text, another turn, another channel, no turn, and a message that never went out [FL-106]", () => {
    const sent = out({ messageId: "msg-0001" });
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", text: "Ya está resuelto." }, [sent])).toBeUndefined();
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0002", text: "Ya lo estoy revisando." }, [sent])).toBeUndefined();
    expect(repeatedInTurn({ channel: "EMAIL", turnId: "trn-0001", text: "Ya lo estoy revisando." }, [sent])).toBeUndefined();
    expect(repeatedInTurn({ channel: "WHATSAPP", text: "Ya lo estoy revisando." }, [sent])).toBeUndefined();
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", text: "Ya lo estoy revisando." }, [out({ status: "BLOCKED" })])).toBeUndefined();
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", text: "Ya lo estoy revisando." }, [out({ status: "FAILED" })])).toBeUndefined();
  });

  it("a text never repeats a template and a template never repeats a text", () => {
    const template = out({ templateName: "reclamo_derivado", templateParams: ["R-2026-000123", "jueves 22/10"], body: "Ya lo estoy revisando." });
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", text: "Ya lo estoy revisando." }, [template])).toBeUndefined();
    expect(repeatedInTurn({ channel: "WHATSAPP", turnId: "trn-0001", template: { name: "reclamo_derivado", params: [] } }, [out({})])).toBeUndefined();
  });
});

describe("repeated WhatsApp in the turn: through the gate [FL-106]", () => {
  async function rigWithTurn() {
    const rig = await gateRig();
    await customerWrote(rig, VALERIA, WROTE, { disclosedEpochs: [] });
    await agentTurn(rig, VALERIA, "trn-0001", [{ status: "INVESTIGATING" }]);
    return rig;
  }
  const ask = (text: string, turnId = "trn-0001") => request("REPLY", { sender: "AGENT", turnId, text });

  it("answers the message already sent: no G2, no tape, no transport, audited with the original id [FL-106]", async () => {
    const rig = await rigWithTurn();
    const first = await rig.gate(ask("Ya lo estoy revisando."), call(rig, "AGENT"));
    expect(first.ok && first.decision).toBe("ALLOWED");
    const tapeBefore = await tapeOf(rig);
    const g2Before = rig.g2.inputs.length;

    const second = await rig.gate(ask("Ya lo estoy revisando."), call(rig, "AGENT"));

    expect(second).toMatchObject({ ok: true, decision: "ALLOWED", messageId: first.messageId, replayOf: first.messageId });
    expect(rig.g2.inputs).toHaveLength(g2Before);
    expect(await tapeOf(rig)).toHaveLength(tapeBefore.length);
    expect(rig.whatsappSent).toHaveLength(1);
    const outbound = (await rig.kit.connector.conversations.listMessages(rig.worldId, VALERIA)).filter((row) => row.direction === "OUT");
    expect(outbound).toHaveLength(1);
    const [audit] = await rig.kit.connector.audit.listByAction(rig.worldId, GATE_AUDIT.REPLAYED);
    expect(audit?.refs).toMatchObject({ messageId: first.messageId, turnId: "trn-0001" });
    expect(JSON.stringify(audit)).not.toContain("Ya lo estoy revisando");
  });

  it("sends a different text of the same turn, and the same text in another turn [FL-106]", async () => {
    const rig = await rigWithTurn();
    await rig.gate(ask("Ya lo estoy revisando."), call(rig, "AGENT"));
    const other = await rig.gate(ask("Ya tengo novedades."), call(rig, "AGENT"));
    expect(other.ok && !("replayOf" in other && other.replayOf !== undefined)).toBe(true);
    await agentTurn(rig, VALERIA, "trn-0002", [{ status: "INVESTIGATING" }]);
    const nextTurn = await rig.gate(ask("Ya lo estoy revisando.", "trn-0002"), call(rig, "AGENT"));
    expect(nextTurn.ok && "replayOf" in nextTurn ? nextTurn.replayOf : undefined).toBeUndefined();
    expect(rig.whatsappSent).toHaveLength(3);
    expect(await rig.kit.connector.audit.listByAction(rig.worldId, GATE_AUDIT.REPLAYED)).toEqual([]);
  });

  it("a blocked attempt is not a sent message: the same text asked again is evaluated again [FL-106]", async () => {
    const rig = await rigWithTurn();
    rig.g2.verdict = { action: "BLOCKED", failure: "BLOCKED" };
    const first = await rig.gate(ask("Ya lo estoy revisando."), call(rig, "AGENT"));
    expect(first.ok).toBe(false);
    rig.g2.verdict = { action: "NONE" };
    const second = await rig.gate(ask("Ya lo estoy revisando."), call(rig, "AGENT"));
    expect(second).toMatchObject({ ok: true, decision: "ALLOWED" });
    expect(rig.whatsappSent).toHaveLength(1);
  });
});
