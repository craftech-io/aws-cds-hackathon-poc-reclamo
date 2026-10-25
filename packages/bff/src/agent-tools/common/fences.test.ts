import { describe, expect, it } from "vitest";
import { ok } from "@reclamo/shared";
import type { ZodType } from "zod";
import type { ToolResponse } from "./context";
import { allDefinitions } from "./catalog";
import { RECIPIENT_FIELDS } from "./define";
import { FENCES, complaintFence, controlFence, identifiedFence, oncePerEventFence, scopeFence } from "./fences";
import { gatewayContext } from "./principal";
import { type ToolTarget, gatewayActionOf } from "./targets";
import { OTHER_CUSTOMER, WORLD, recording, stubTarget, toolWorld, type ToolWorld } from "./testing";

function errorOf(response: ToolResponse): { code: string; reason?: string; message: string } {
  if (response.ok) throw new Error(`expected a failure, got ${JSON.stringify(response)}`);
  return response.error;
}

async function call(world: ToolWorld, target: ToolTarget, tool: string, token: string, input: Record<string, unknown> = {}, overrides = {}) {
  const { runtime, recorder } = stubTarget(target, world.deps, overrides);
  const response = await runtime.handle({ sessionToken: token, ...input }, gatewayContext(gatewayActionOf(target, tool)));
  return { response, recorder };
}

describe("the fences run in order: scope, control, complaint, identification, once per event", () => {
  it("is the order of FENCES", () => {
    expect(FENCES).toEqual([scopeFence, controlFence, complaintFence, identifiedFence, oncePerEventFence]);
  });
});

describe("LAM-STRICT: only what the schema declares, with the real values", () => {
  it("refuses decision and capOverride with any value, audits LAM-STRICT and never runs the tool", async () => {
    const world = await toolWorld();
    await world.identify();
    const complaint = await world.addComplaint();
    await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-0001", kind: "SETTLEMENT_MATCH", refId: "rec-0001" });
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    const values = ["APPROVED", "", true, { tier: "SUPERVISOR" }, null, 0];
    for (const value of values) {
      const approval = await call(world, "handoff", "request_operator_approval", turn.token, { evidenceId: "rec-0001", justification: "Sobre el tope.", decision: value });
      expect(errorOf(approval.response)).toMatchObject({ code: "INVALID", reason: "VALIDATION", message: "decision is never accepted (denied by policy)" });
      expect(approval.recorder.calls).toEqual([]);
      const payment = await call(world, "actions", "apply_payment", turn.token, { reconciliationId: "rec-0001", capOverride: value });
      expect(errorOf(payment.response)).toMatchObject({ code: "INVALID", message: "capOverride is never accepted (denied by policy)" });
      expect(payment.recorder.calls).toEqual([]);
    }
    const rows = await world.auditRows();
    expect(rows).toHaveLength(values.length * 2);
    for (const row of rows) expect(row).toMatchObject({ action: "DENY", actor: "AGENT", ruleIds: ["LAM-STRICT"], outcome: "VALIDATION" });
    expect(await world.connector.sessions.listTurnResults(WORLD, turn.turnId)).toEqual([]);
  });

  it("refuses undeclared keys, values outside the real enums and the cross-field rules, naming fields and never values", async () => {
    const world = await toolWorld();
    await world.addInboundMessage("msg-0001");
    await world.identify();
    const complaint = await world.addComplaint();
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    const cases: Array<[ToolTarget, string, Record<string, unknown>, string]> = [
      ["messaging", "send_whatsapp", { kind: "REPLY", text: "Hola", recipient: "+5491100000000" }, "recipient"],
      ["messaging", "send_whatsapp", { kind: "COLLECTION_REMINDER", text: "Pagá la cuota" }, "kind"],
      ["messaging", "send_whatsapp", { kind: "REPLY", text: "Hola", template: { name: "reclamo_novedad", params: [] } }, "text"],
      ["messaging", "send_whatsapp", { kind: "REPLY" }, "text"],
      ["investigation", "reconcile_payment", { source: "SETTLEMENT" }, "readingId"],
      ["investigation", "reconcile_payment", { source: "WALLET" }, "movementId"],
      ["complaints", "register_complaint", { kind: "CONSULTA", type: "DUPLICATE_DEBIT", summary: "Duda", sourceMessageId: "msg-0001" }, "type"],
      ["complaints", "update_complaint", { status: "CLOSED" }, "status"],
      ["complaints", "answer_complaint_in_writing", { outcome: "IN_FAVOUR", draftBody: "Texto", requestedAttachments: ["COLLECTION_NOTICE"] }, "requestedAttachments"],
      ["handoff", "escalate_to_human", { reason: "OTHER", summary: "y".repeat(501) }, "summary"],
    ];
    for (const [target, tool, input, field] of cases) {
      const { response, recorder } = await call(world, target, tool, turn.token, input);
      const error = errorOf(response);
      expect(error, `${tool} ${field}`).toMatchObject({ code: "INVALID", reason: "VALIDATION" });
      expect(error.message).toContain(field);
      expect(error.message).not.toContain("+5491100000000");
      expect(recorder.calls).toEqual([]);
    }
  });

  it("declares no recipient, no unscoped id and the Cedar fields exactly where the policy reads them", () => {
    const unscopedAllowed = new Set(["clauseIds"]);
    const idLike = /(Id|Ids|Nonce|^ref)$/;
    for (const { definition } of allDefinitions()) {
      const walk = (shape: Readonly<Record<string, ZodType>>, prefix: string): string[] =>
        Object.entries(shape).flatMap(([field, schema]) => {
          const path = `${prefix}${field}`;
          const def = (schema as unknown as { def: { innerType?: ZodType; element?: ZodType; shape?: Record<string, ZodType> } }).def;
          const inner = (def.innerType as unknown as { def?: { element?: ZodType; shape?: Record<string, ZodType> } } | undefined)?.def ?? def;
          const element = (inner.element as unknown as { def?: { shape?: Record<string, ZodType> } } | undefined)?.def;
          if (element?.shape) return [path, ...walk(element.shape, `${path}[].`)];
          if (inner.shape) return [path, ...walk(inner.shape, `${path}.`)];
          return [path];
        });
      const paths = walk(definition.fields as Readonly<Record<string, ZodType>>, "");
      for (const path of paths) {
        const leaf = path.split(".").pop() ?? path;
        if (idLike.test(leaf) && !unscopedAllowed.has(leaf)) expect(definition.scoped, `${definition.name}.${path}`).toHaveProperty([path]);
        expect(RECIPIENT_FIELDS as readonly string[], `${definition.name}.${path}`).not.toContain(leaf);
      }
      const expectedDenied = definition.name === "request_operator_approval" ? ["decision"] : ["apply_payment", "reverse_charge", "refund_duplicate_debit", "request_transfer_reversal"].includes(definition.name) ? ["capOverride"] : [];
      expect(definition.deniedFields, definition.name).toEqual(expectedDenied);
    }
  });

  it("marks Id, Rc and the control fence as docs/tool-catalog.md does", () => {
    const flags = Object.fromEntries(allDefinitions().map(({ definition: d }) => [d.name, `${d.fences.identified ? "Id" : ""}${d.fences.complaint ? "Rc" : ""}${d.fences.control ? "Ctl" : ""}`]));
    expect(flags).toEqual({
      identify_customer: "",
      verify_challenge: "",
      get_account: "Id",
      list_operations: "Id",
      get_loan: "Id",
      get_instalments: "Id",
      get_fee_rules: "Id",
      get_terms: "",
      quote_early_payoff: "Id",
      read_receipt: "IdRc",
      reconcile_payment: "IdRc",
      check_charge: "IdRc",
      check_duplicate_debit: "IdRc",
      get_transfer_status: "IdRc",
      get_disbursement: "IdRc",
      apply_payment: "IdRcCtl",
      reverse_charge: "IdRcCtl",
      refund_duplicate_debit: "IdRcCtl",
      request_transfer_reversal: "IdRcCtl",
      freeze_outgoing: "IdRcCtl",
      request_account_closure: "IdRcCtl",
      request_data_change: "IdRcCtl",
      register_complaint: "",
      update_complaint: "IdRcCtl",
      answer_complaint_in_writing: "IdRcCtl",
      send_whatsapp: "Ctl",
      escalate_to_human: "",
      request_operator_approval: "RcCtl",
    });
  });
});

describe("LAM-SCOPE: every id of the input belongs to the session", () => {
  it("refuses a complaint, an evidence, a message, a nonce, a loan or a button of anyone else with FORBIDDEN and a DENY audit", async () => {
    const world = await toolWorld();
    await world.identify();
    const mine = await world.addComplaint();
    const foreign = await world.addComplaint({ customerId: OTHER_CUSTOMER });
    const notInSession = await world.addComplaint();
    await world.addEvidence({ complaintId: foreign.complaintId, evidenceId: "evd-foreign", kind: "SETTLEMENT_MATCH", refId: "rec-foreign" });
    await world.addInboundMessage("msg-foreign", OTHER_CUSTOMER);
    await world.connector.write(world.connector.claims.putNonceOp({ worldId: WORLD, nonce: "nonce-foreign", action: "CONFIRM_CLOSURE", phoneHash: "h", customerId: OTHER_CUSTOMER, createdAtReal: new Date().toISOString() }));
    world.owned.add("L-0001");
    const turn = await world.openTurn({ complaintIds: [mine.complaintId, foreign.complaintId] });
    const cases: Array<[ToolTarget, string, Record<string, unknown>, string]> = [
      ["complaints", "update_complaint", { complaintId: foreign.complaintId, note: "x" }, "complaintId"],
      ["complaints", "update_complaint", { complaintId: notInSession.complaintId, note: "x" }, "complaintId"],
      ["actions", "apply_payment", { reconciliationId: "rec-foreign" }, "reconciliationId"],
      ["actions", "request_data_change", { field: "EMAIL", sourceMessageId: "msg-foreign" }, "sourceMessageId"],
      ["actions", "request_account_closure", { confirmNonce: "nonce-foreign" }, "confirmNonce"],
      ["account", "get_loan", { loanId: "L-0002" }, "loanId"],
      ["investigation", "check_charge", { chargeId: "chg-0009" }, "chargeId"],
      ["messaging", "send_whatsapp", { kind: "REPLY", text: "Hola", buttons: [{ action: "SEE_DETAIL", ref: "L-0001" }, { action: "SEE_DETAIL", ref: foreign.complaintId }] }, "buttons.1.ref"],
    ];
    for (const [target, tool, input, path] of cases) {
      const { response, recorder } = await call(world, target, tool, turn.token, input);
      expect(errorOf(response), `${tool} ${path}`).toMatchObject({ code: "FORBIDDEN", reason: "NOT_IN_SESSION" });
      expect(errorOf(response).message.startsWith(path)).toBe(true);
      expect(recorder.calls).toEqual([]);
    }
    const denied = (await world.auditRows()).filter((row) => row.ruleIds?.includes("LAM-SCOPE"));
    expect(denied).toHaveLength(cases.length);
    expect(denied.map((row) => String(row.detail?.["path"])).sort()).toEqual(cases.map(([, , , path]) => path).sort());
  });

  it("lets the session's own ids through and hands the implementation the complaint they name", async () => {
    const world = await toolWorld();
    await world.identify();
    await world.addInboundMessage("msg-0001");
    const first = await world.addComplaint();
    const second = await world.addComplaint({ type: "UNRECOGNIZED_CHARGE" });
    await world.addEvidence({ complaintId: first.complaintId, evidenceId: "evd-0001", kind: "SETTLEMENT_MATCH", refId: "rec-0001" });
    world.owned.add("L-0001");
    const turn = await world.openTurn({ complaintIds: [first.complaintId, second.complaintId] });
    const payment = await call(world, "actions", "apply_payment", turn.token, { reconciliationId: "rec-0001" });
    expect(payment.response.ok).toBe(true);
    expect(payment.recorder.calls[0]?.complaint?.complaintId).toBe(first.complaintId);
    expect(payment.recorder.calls[0]?.findings.evidence.map((item) => item.evidenceId)).toEqual(["evd-0001"]);
    expect((await call(world, "account", "get_instalments", turn.token, { loanId: "L-0001" })).response.ok).toBe(true);
    expect((await call(world, "actions", "request_data_change", turn.token, { field: "ADDRESS", sourceMessageId: "msg-0001" })).response.ok).toBe(true);
  });
});

describe("LAM-CONTROL: with an operator in charge the agent neither acts nor sends", () => {
  it("answers CONTROL_OPERATOR for sends and actions and still lets reads through", async () => {
    const world = await toolWorld();
    await world.identify();
    const complaint = await world.addComplaint();
    await world.takeOver();
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    expect(errorOf((await call(world, "messaging", "send_whatsapp", turn.token, { kind: "REPLY", text: "Hola" })).response).code).toBe("CONTROL_OPERATOR");
    expect(errorOf((await call(world, "actions", "freeze_outgoing", turn.token, { reason: "CUSTOMER_REQUEST" })).response).code).toBe("CONTROL_OPERATOR");
    expect((await call(world, "account", "get_account", turn.token)).response.ok).toBe(true);
    const denied = (await world.auditRows()).filter((row) => row.ruleIds?.includes("LAM-CONTROL"));
    expect(denied.map((row) => row.refs["deniedTool"]).sort()).toEqual(["FREEZE_OUTGOING", "SEND_WHATSAPP"]);
  });
});

describe("[FL-012] LAM-COMPLAINT-REQUIRED: investigating or acting needs an open complaint of the session", () => {
  it("[FL-012] answers COMPLAINT_REQUIRED to an investigation asked for before register_complaint, identified or not", async () => {
    const world = await toolWorld();
    world.owned.add("chg-0001");
    const before = await world.openTurn();
    expect(errorOf((await call(world, "investigation", "check_charge", before.token, { chargeId: "chg-0001" })).response).code).toBe("COMPLAINT_REQUIRED");
    await world.identify();
    for (const [tool, input] of [["check_charge", { chargeId: "chg-0001" }], ["get_disbursement", {}], ["check_duplicate_debit", {}]] as const) {
      const { response, recorder } = await call(world, "investigation", tool, before.token, input);
      expect(errorOf(response), tool).toMatchObject({ code: "COMPLAINT_REQUIRED" });
      expect(recorder.calls).toEqual([]);
    }
    const denied = (await world.auditRows()).filter((row) => row.ruleIds?.includes("LAM-COMPLAINT-REQUIRED"));
    expect(denied).toHaveLength(4);

    // register_complaint itself needs neither identification nor a complaint.
    await world.addInboundMessage("msg-0002");
    const registered = await call(world, "complaints", "register_complaint", before.token, { kind: "RECLAMO", type: "UNRECOGNIZED_CHARGE", summary: "No reconoce un débito de ayer.", sourceMessageId: "msg-0002" });
    expect(registered.response.ok).toBe(true);

    // Once the complaint is part of the session, the same investigation goes through on it.
    const complaint = await world.addComplaint({ type: "UNRECOGNIZED_CHARGE" });
    await world.connector.sessions.addComplaintToSession(WORLD, before.sessionId, complaint.complaintId);
    const after = await call(world, "investigation", "check_charge", before.token, { chargeId: "chg-0001" });
    expect(after.response.ok).toBe(true);
    expect(after.recorder.calls[0]?.complaint?.complaintId).toBe(complaint.complaintId);
  });

  it("[FL-012] does not take an answered complaint as open, and asks which one when several are open", async () => {
    const world = await toolWorld();
    await world.identify();
    const answered = await world.addComplaint({ status: "ANSWERED" });
    const lone = await world.openTurn({ complaintIds: [answered.complaintId] });
    expect(errorOf((await call(world, "investigation", "get_disbursement", lone.token)).response).code).toBe("COMPLAINT_REQUIRED");
    expect(errorOf((await call(world, "complaints", "update_complaint", lone.token, { complaintId: answered.complaintId, note: "x" })).response).code).toBe("COMPLAINT_REQUIRED");

    const a = await world.addComplaint();
    const b = await world.addComplaint({ type: "DUPLICATE_DEBIT" });
    const several = await world.openTurn({ complaintIds: [a.complaintId, b.complaintId] });
    expect(errorOf((await call(world, "complaints", "update_complaint", several.token, { note: "x" })).response)).toMatchObject({ code: "INVALID", reason: "AMBIGUOUS_COMPLAINT" });
    const named = await call(world, "complaints", "update_complaint", several.token, { complaintId: a.complaintId, note: "x" });
    expect(named.recorder.calls[0]?.complaint?.complaintId).toBe(a.complaintId);
    const implicit = await call(world, "investigation", "check_duplicate_debit", several.token);
    expect(implicit.recorder.calls[0]?.complaint?.complaintId).toBe(b.complaintId);
  });
});

describe("[FL-012] an investigation that names no complaint lands only on a complaint of its own type", () => {
  const CASES = [
    ["check_charge", { chargeId: "chg-0001" }, "UNRECOGNIZED_CHARGE"],
    ["check_duplicate_debit", {}, "DUPLICATE_DEBIT"],
    ["get_transfer_status", { transferId: "trf-0001" }, "TRANSFER_NOT_CREDITED"],
    ["get_disbursement", {}, "DISBURSEMENT_NOT_RECEIVED"],
    ["reconcile_payment", { source: "WALLET", movementId: "mov-0001" }, "PAYMENT_NOT_REFLECTED"],
  ] as const;
  for (const [tool, input, type] of CASES) {
    it(`[FL-012] ${tool} goes on the older ${type}, never on a newer complaint of another type, and refuses with only that one open`, async () => {
      const world = await toolWorld();
      for (const id of ["chg-0001", "trf-0001", "mov-0001"]) world.owned.add(id);
      await world.identify();
      const own = await world.addComplaint({ type });
      const newer = await world.addComplaint({ type: type === "PAYMENT_NOT_REFLECTED" ? "DATA_CHANGE" : "PAYMENT_NOT_REFLECTED" });
      const both = await world.openTurn({ complaintIds: [own.complaintId, newer.complaintId] });
      const routed = await call(world, "investigation", tool, both.token, input);
      expect(routed.recorder.calls.map((item) => item.complaint?.complaintId)).toEqual([own.complaintId]);

      const alone = await world.openTurn({ complaintIds: [newer.complaintId] });
      const refused = await call(world, "investigation", tool, alone.token, input);
      expect(errorOf(refused.response)).toMatchObject({ code: "COMPLAINT_REQUIRED", reason: "COMPLAINT_TYPE" });
      expect(refused.recorder.calls).toEqual([]);
    });
  }
});

describe("[FL-049] an investigation tool on an operation the customer did not make", () => {
  it("[FL-049] get_transfer_status refuses an UNKNOWN_OPERATION complaint pointing to the freeze and a FRAUD handoff, never to register_complaint", async () => {
    const world = await toolWorld();
    world.owned.add("trf-0001");
    await world.identify();
    const unknown = await world.addComplaint({ type: "UNKNOWN_OPERATION" });
    const turn = await world.openTurn({ complaintIds: [unknown.complaintId] });
    const refused = await call(world, "investigation", "get_transfer_status", turn.token, { transferId: "trf-0001" });
    const error = errorOf(refused.response);
    expect(error).toMatchObject({ code: "COMPLAINT_REQUIRED", reason: "COMPLAINT_TYPE" });
    expect(error.message).toMatch(/freeze_outgoing with reason UNKNOWN_OPERATION[\s\S]*escalate_to_human with reason FRAUD/);
    expect(error.message).not.toContain("register_complaint");
    expect(refused.recorder.calls).toEqual([]);
  });
});

describe("LAM-IDENTIFIED: data and actions need the challenge passed in the last 30 real minutes", () => {
  it("answers NOT_IDENTIFIED before the challenge and after the window, on the real clock", async () => {
    const world = await toolWorld();
    const turn = await world.openTurn();
    expect(errorOf((await call(world, "account", "get_account", turn.token)).response).code).toBe("NOT_IDENTIFIED");
    expect((await call(world, "account", "get_terms", turn.token, { topic: "COMPLAINT_RIGHTS" })).response.ok).toBe(true);
    await world.identify(30 * 60_000);
    expect((await call(world, "account", "get_account", turn.token)).response.ok).toBe(true);
    world.advanceReal(25 * 60_000);
    const later = await world.openTurn();
    expect((await call(world, "account", "get_account", later.token)).response.ok).toBe(true);
    world.advanceReal(6 * 60_000);
    expect(errorOf((await call(world, "account", "get_account", later.token)).response).code).toBe("NOT_IDENTIFIED");
    expect((await world.auditRows()).filter((row) => row.ruleIds?.includes("LAM-IDENTIFIED"))).toHaveLength(2);
  });
});

describe("LAM-ONCE-PER-EVENT: one COMPLAINT_UPDATE per event that opened the turn", () => {
  it("answers CONFLICT to a second COMPLAINT_UPDATE of the same event, lets other kinds and other events through, and does not count a failure", async () => {
    const world = await toolWorld();
    const update = { kind: "COMPLAINT_UPDATE", template: { name: "reclamo_novedad", params: ["Ana", "R-2026-000001", "PAYMENT_REFLECTED"] } };
    const failing = recording(async () => ({ ok: false, error: { code: "GROUNDING_FAIL", message: "not grounded" } }));
    const turn = await world.openTurn({ eventId: "evt-settlement-1" });
    expect(errorOf((await call(world, "messaging", "send_whatsapp", turn.token, update, { send_whatsapp: failing.implementation })).response).code).toBe("GROUNDING_FAIL");
    expect((await call(world, "messaging", "send_whatsapp", turn.token, update)).response.ok).toBe(true);
    const second = await call(world, "messaging", "send_whatsapp", turn.token, update);
    expect(errorOf(second.response)).toMatchObject({ code: "CONFLICT" });
    expect(second.recorder.calls).toEqual([]);
    expect((await call(world, "messaging", "send_whatsapp", turn.token, { kind: "REPLY", text: "Listo." })).response.ok).toBe(true);
    const next = await world.openTurn({ eventId: "evt-settlement-2" });
    expect((await call(world, "messaging", "send_whatsapp", next.token, update, { send_whatsapp: async () => ok({ decision: "ALLOWED" }) })).response.ok).toBe(true);
    const denied = (await world.auditRows()).filter((row) => row.ruleIds?.includes("LAM-ONCE-PER-EVENT"));
    expect(denied).toHaveLength(1);
  });
});
