// PolicyAudit (docs/architecture.md §12, FL-075) over the real gate in memory: a world whose every send
// went through the gate is clean; a send fabricated outside it, collection wording that reached
// WhatsApp, an imputation on someone else's settlement line and a chain that disagrees with its anchors
// are violations, each recorded once; a send whose transport died after the provider accepted is not.
import { describe, expect, it } from "vitest";
import { ChannelError } from "@reclamo/shared";
import { anchorStreamName } from "../complaints/anchors";
import { MemoryAnchorLog } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, complaint as complaintRow, email as emailRow, evidence as evidenceRow, message as messageRow, worldMeta } from "../connector/testing";
import { writeAnchors } from "../handlers/anchor-writer";
import { appendTape, payloadHashOf } from "../outbound/tape";
import { CUSTOMERS, MARTIN, OPERATOR, VALERIA, call, customerWrote, gateRig, request } from "../outbound/testing";
import type { TapeEntry } from "../domain/ledger";
import { runPolicyAudit } from "./audit";
import { tapeReason } from "./outbound";
import type { PolicyAuditDeps } from "./types";

const WROTE = "2026-10-07T10:05:00-03:00";
/** An operator took the conversation at 10:06, as `conversation.take` records it (with its history). */
const TAKEN = { control: "OPERATOR" as const, controlledBy: "stf-operator-01", controlHistory: [{ from: "AGENT" as const, to: "OPERATOR" as const, atSim: "2026-10-07T10:06:00-03:00", by: OPERATOR }] };
type Rig = Awaited<ReturnType<typeof gateRig>>;

/** The demo world READY with Valeria's conversation taken by an operator, who answers once through the gate. */
async function cleanWorld(): Promise<Rig> {
  const rig = await gateRig();
  await rig.kit.connector.worlds.register(worldMeta(rig.worldId, { status: "READY" }));
  await customerWrote(rig, VALERIA, WROTE, TAKEN);
  const outcome = await rig.gate(request("REPLY", { sender: OPERATOR, text: "Hola Valeria, ya estoy revisando tu caso." }), call(rig, OPERATOR));
  expect(outcome).toMatchObject({ ok: true, decision: "ALLOWED" });
  return rig;
}

/** Every anchor the commits asked for, written by the real AnchorWriter logic into a memory log group. */
async function anchored(rig: Rig): Promise<MemoryAnchorLog> {
  const anchors = new MemoryAnchorLog();
  for (const requested of rig.kit.anchorRequests) await writeAnchors(requested, { connector: rig.kit.connector, sink: anchors.sink(), log: rig.kit.log, now: () => TEST_NOW });
  return anchors;
}

function auditDeps(rig: Rig, anchors: MemoryAnchorLog, customers = CUSTOMERS): PolicyAuditDeps {
  return { connector: rig.kit.connector, chainKey: rig.kit.deps.chainKey, anchors, customers: { get: async (_worldId, customerId) => customers[customerId] }, log: rig.kit.log, now: () => TEST_NOW };
}

const metricLines = (rig: Rig) => rig.lines.filter((line) => line.message === "policy_audit.violation");

describe("PolicyAudit: tape and policy of every send [FL-075]", () => {
  it("[FL-075] a world whose every send went through the gate has zero violations and its chains verify against their anchors", async () => {
    const rig = await cleanWorld();
    const report = await runPolicyAudit(auditDeps(rig, await anchored(rig)), { worldId: rig.worldId });
    expect(report).toMatchObject({ worldId: "demo", epoch: 1, messagesChecked: 1, failed: 0, violations: [], warnings: [] });
    expect(report.chains).toEqual([
      { chain: "REG", result: "ok", entries: 0 },
      { chain: "RRI", result: "ok", entries: 0 },
      { chain: "TAPE", result: "ok", entries: 2 },
    ]);
    expect(await rig.kit.connector.audit.listByAction(rig.worldId, "VIOLATION")).toEqual([]);
  });

  it("[FL-075] entries the AnchorWriter has not anchored yet are a CHAIN_PARTIAL warning, never a violation", async () => {
    const rig = await cleanWorld();
    const report = await runPolicyAudit(auditDeps(rig, new MemoryAnchorLog()), { worldId: rig.worldId });
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([{ warning: "CHAIN_PARTIAL", chain: "TAPE", unanchored: [1, 2] }]);
  });

  it("[FL-075] an outbound fabricated outside the gate is a VIOLATION with the metric line, recorded once however often the audit runs", async () => {
    const rig = await cleanWorld();
    await rig.kit.connector.conversations.putMessage(messageRow(rig.worldId, { customerId: VALERIA, messageId: "msg-forged", direction: "OUT", kind: "REPLY", sender: OPERATOR, status: "SENT", body: "Hola Valeria, novedades de tu caso.", atSim: "2026-10-07T10:20:00-03:00", sentAtSim: "2026-10-07T10:20:00-03:00" }));
    const anchors = await anchored(rig);
    const first = await runPolicyAudit(auditDeps(rig, anchors), { worldId: rig.worldId });
    expect(first.violations).toEqual([expect.objectContaining({ check: "TAPE_ALLOWED", reason: "NO_ALLOWED", recorded: true, refs: expect.objectContaining({ messageId: "msg-forged" }) })]);
    expect(metricLines(rig)).toEqual([expect.objectContaining({ metric: "PolicyViolations", check: "TAPE_ALLOWED", reason: "NO_ALLOWED" })]);
    const second = await runPolicyAudit(auditDeps(rig, anchors), { worldId: rig.worldId });
    expect(second.violations).toEqual([expect.objectContaining({ check: "TAPE_ALLOWED", recorded: false })]);
    const recorded = await rig.kit.connector.audit.listByAction(rig.worldId, "VIOLATION");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ actor: "SYSTEM", outcome: "TAPE_ALLOWED", primaryRef: "MSG#msg-forged", refs: { check: "TAPE_ALLOWED", reason: "NO_ALLOWED" } });
  });

  it("[FL-075] an email the world sent without an ALLOWED decision is a violation", async () => {
    const rig = await cleanWorld();
    await rig.kit.connector.emails.put(emailRow(rig.worldId, { customerId: VALERIA, mailId: "mail-forged", messageId: "msg-mail-forged" }));
    const report = await runPolicyAudit(auditDeps(rig, await anchored(rig)), { worldId: rig.worldId });
    expect(report.violations).toEqual([expect.objectContaining({ check: "TAPE_ALLOWED", key: "TAPE_ALLOWED#MAIL#mail-forged", reason: "NO_ALLOWED" })]);
  });

  it("[FL-075] a send whose transport timed out after the provider may have accepted it is not a violation", async () => {
    const rig = await cleanWorld();
    rig.failWhatsApp = new ChannelError("TIMEOUT", "WHATSAPP", "the send timed out");
    const outcome = await rig.gate(request("REPLY", { sender: OPERATOR, text: "Sigo revisando tu caso, te escribo en un rato." }), call(rig, OPERATOR));
    expect(outcome).toMatchObject({ ok: false, failure: { error: { code: "UNKNOWN_DELIVERY" } } });
    const report = await runPolicyAudit(auditDeps(rig, await anchored(rig)), { worldId: rig.worldId });
    expect(report.messagesChecked).toBe(2);
    expect(report.violations).toEqual([]);
  });

  it("[FL-075] the policy of that moment is re-evaluated: collection wording that reached WhatsApp is a violation even with its ALLOWED entry", async () => {
    const rig = await cleanWorld();
    const atSim = "2026-10-07T10:30:00-03:00";
    const body = "Valeria, tenés la cuota 3 vencida, pagala hoy para evitar recargos.";
    const allowed = await appendTape(rig.deps, { worldId: rig.worldId, epoch: 1, atSim, decision: "ALLOWED", ruleIds: ["CH-SENDER"], ruleSetVersion: "rs-test", sender: OPERATOR, channel: "WHATSAPP", kind: "REPLY", customerId: VALERIA, payloadHash: payloadHashOf(body), messageId: "msg-slipped" }, rig.kit.log);
    await rig.kit.connector.conversations.putMessage(messageRow(rig.worldId, { customerId: VALERIA, messageId: "msg-slipped", direction: "OUT", kind: "REPLY", sender: OPERATOR, status: "DELIVERED", body, atSim, sentAtSim: atSim, tapeRef: allowed.tapeId }));
    const report = await runPolicyAudit(auditDeps(rig, await anchored(rig)), { worldId: rig.worldId });
    expect(report.violations).toEqual([expect.objectContaining({ check: "POLICY_REEVALUATION", reason: "BLOCKED_AT_ITS_INSTANT", ruleIds: expect.arrayContaining(["CH-WA-NO-COLLECTION"]) })]);
  });

  it("[FL-075] a hand-back to the agent in force when the operator's message went out makes it a violation; one recorded after it does not", async () => {
    const handBack = async (atSim: string) => {
      const rig = await cleanWorld();
      const { conversations } = rig.kit.connector;
      const meta = await conversations.getMeta(rig.worldId, VALERIA);
      await rig.kit.connector.write(conversations.setControlOp({ worldId: rig.worldId, customerId: VALERIA, version: meta?.version ?? 1, from: "OPERATOR", to: "AGENT", by: OPERATOR, atSim }));
      return runPolicyAudit(auditDeps(rig, await anchored(rig)), { worldId: rig.worldId });
    };
    expect((await handBack("2026-10-07T10:30:00-03:00")).violations).toEqual([]);
    const report = await handBack("2026-10-07T10:08:00-03:00");
    expect(report.violations).toEqual([expect.objectContaining({ check: "POLICY_REEVALUATION", reason: "BLOCKED_AT_ITS_INSTANT", ruleIds: ["CH-CONTROL"] })]);
  });
});

describe("PolicyAudit: the tape of one message [FL-075]", () => {
  const entry = (decision: TapeEntry["decision"], seq: number, payloadHash?: string): TapeEntry =>
    ({ worldId: "demo", epoch: 1, seq, decision, messageId: "msg-1", ...(payloadHash === undefined ? {} : { payloadHash }) }) as TapeEntry;
  const HASH = "a".repeat(64);

  it("[FL-075] ALLOWED before DISPATCH with one payload hash is clean; ALLOWED alone (a timeout after the send) too", () => {
    expect(tapeReason([entry("ALLOWED", 4, HASH), entry("DISPATCH", 5)])).toBeUndefined();
    expect(tapeReason([entry("ALLOWED", 4, HASH)])).toBeUndefined();
  });

  it("[FL-075] a DISPATCH without an earlier ALLOWED, two hashes for one message or no hash are findings", () => {
    expect(tapeReason([entry("DISPATCH", 5)])).toBe("NO_ALLOWED");
    expect(tapeReason([entry("DISPATCH", 3), entry("ALLOWED", 4, HASH)])).toBe("DISPATCH_BEFORE_ALLOWED");
    expect(tapeReason([entry("ALLOWED", 4, HASH), entry("ALLOWED", 6, "b".repeat(64)), entry("DISPATCH", 7)])).toBe("PAYLOAD_MISMATCH");
    expect(tapeReason([entry("ALLOWED", 4)])).toBe("NO_PAYLOAD_HASH");
  });
});

describe("PolicyAudit: imputations and chains [FL-075]", () => {
  const line = (customerRef: string, loanRef: string) => ({ result: "MATCHED", source: "SETTLEMENT", line: { network: "NORTE", operationCode: "NOR-0001", amount: 6_421_000, paidAt: SIM_NOW, customerRef, loanRef } });

  it("[FL-075] no imputation rests on another customer's line or loan, and an executed imputation needs its matched line", async () => {
    const rig = await cleanWorld();
    const { connector } = rig.kit;
    await connector.write(connector.complaints.createOp(complaintRow(rig.worldId, { customerId: VALERIA, status: "INVESTIGATING" })));
    await connector.caseItems.putEvidence(evidenceRow(rig.worldId, { evidenceId: "evd-own", kind: "SETTLEMENT_MATCH", details: line(VALERIA, "L-0001") }));
    await connector.caseItems.putEvidence(evidenceRow(rig.worldId, { evidenceId: "evd-payer", kind: "SETTLEMENT_MATCH", details: line(MARTIN, "L-0009") }));
    await connector.caseItems.putEvidence(evidenceRow(rig.worldId, { evidenceId: "evd-loan", kind: "SETTLEMENT_MATCH", details: line(VALERIA, "L-0009") }));
    await connector.caseItems.putEvidence(evidenceRow(rig.worldId, { evidenceId: "evd-summary", kind: "SETTLEMENT_MATCH", details: { seeded: true, summary: "pago no reflejado" } }));
    await connector.caseItems.putAction({ worldId: rig.worldId, complaintId: "cmp-0001", actionId: "act-orphan", kind: "APPLY_PAYMENT", status: "EXECUTED", amountCents: 6_421_000, idempotencyKey: "imp-orphan", atSim: SIM_NOW, actor: "AGENT" });
    const report = await runPolicyAudit(auditDeps(rig, await anchored(rig)), { worldId: rig.worldId });
    expect(report.imputationsChecked).toBe(4);
    expect(report.violations.map((violation) => [violation.check, violation.reason, violation.refs["evidenceId"]])).toEqual([
      ["FOREIGN_SETTLEMENT", "LOAN_NOT_CUSTOMERS", "evd-loan"],
      ["FOREIGN_SETTLEMENT", "PAYER_NOT_CUSTOMER", "evd-payer"],
      ["FOREIGN_SETTLEMENT", "IMPUTATION_WITHOUT_LINE", "none-act-orphan"],
    ]);
  });

  it("[FL-075] without the core, a line's loan is checked against the complaint's own loan", async () => {
    const rig = await cleanWorld();
    const { connector } = rig.kit;
    await connector.write(connector.complaints.createOp(complaintRow(rig.worldId, { customerId: VALERIA, status: "INVESTIGATING", subject: { loanId: "L-0001" } })));
    await connector.caseItems.putEvidence(evidenceRow(rig.worldId, { evidenceId: "evd-loan", kind: "SETTLEMENT_MATCH", details: line(VALERIA, "L-0002") }));
    const { customers: _customers, ...withoutCore } = auditDeps(rig, await anchored(rig));
    const report = await runPolicyAudit(withoutCore, { worldId: rig.worldId });
    expect(report.violations).toEqual([expect.objectContaining({ check: "FOREIGN_SETTLEMENT", reason: "LOAN_NOT_SUBJECT" })]);
  });

  it("[FL-075] a chain that disagrees with its first anchor is a CHAIN_BROKEN violation", async () => {
    const rig = await cleanWorld();
    const anchors = await anchored(rig);
    anchors.add(anchorStreamName(rig.worldId, 1, "TAPE"), JSON.stringify({ worldId: rig.worldId, epoch: 1, chain: "TAPE", seq: 1, hash: "f".repeat(64), atReal: TEST_NOW.toISOString() }));
    const report = await runPolicyAudit(auditDeps(rig, anchors), { worldId: rig.worldId });
    expect(report.chains.find((chain) => chain.chain === "TAPE")?.result).toBe("broken");
    expect(report.violations).toEqual([expect.objectContaining({ check: "CHAIN_BROKEN", ruleIds: ["ADR-0014"], refs: expect.objectContaining({ chain: "TAPE", brokenAt: "1" }) })]);
  });

  it("refuses a world that does not exist", async () => {
    const rig = await gateRig();
    await expect(runPolicyAudit(auditDeps(rig, new MemoryAnchorLog()), { worldId: rig.worldId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
