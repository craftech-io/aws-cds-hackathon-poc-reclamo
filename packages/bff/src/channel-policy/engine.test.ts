import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRuleId } from "../copy/types";
import { POLICY_VERSION, evaluate } from "./engine";
import { CHANNEL_RULES } from "./kinds";
import {
  MARTIN,
  OPERATOR,
  OPERATOR_STAFF,
  ROCIO,
  VALERIA,
  agentReply,
  complaintOf,
  formalNotice,
  inbound,
  operatorCompose,
  optedIn,
  optedOutAt,
  proactiveUpdate,
  sent,
  takenAt,
  updateByEmail,
  withoutOptIn,
} from "./testing";
import type { PolicyDecision } from "./types";

function outcome(decision: PolicyDecision) {
  return { decision: decision.decision, ruleIds: decision.ruleIds, errorCode: decision.errorCode };
}

const UPDATE_TEMPLATE = { name: "reclamo_novedad" as const, params: ["Martín", "R-2026-000002", "HUMAN_REVIEWED"] };

describe("channel policy: order and outcome", () => {
  afterEach(() => vi.useRealTimers());

  it("evaluates every rule in the order of docs/design-brief.md §7 and lists the ones that passed", () => {
    expect(CHANNEL_RULES).toEqual(ChannelRuleId.options);
    const decision = evaluate(agentReply());
    expect(decision).toMatchObject({ decision: "ALLOWED", reply: true, ruleSetVersion: POLICY_VERSION, window: { state: "OPEN" } });
    expect(decision.evaluated.map((entry) => entry.ruleId)).toEqual([...ChannelRuleId.options]);
    expect(decision.evaluated.filter((entry) => entry.result === "SKIP").map((entry) => entry.ruleId)).toEqual(["CH-OPTIN", "CH-WA-CUSTOMER-INITIATED", "CH-CONTACT-HOURS", "CH-MAX-PER-DAY", "CH-FORMAL-CONTENT"]);
    expect(decision.ruleIds).toEqual(decision.evaluated.filter((entry) => entry.result === "PASS").map((entry) => entry.ruleId));
    expect(decision.ruleSetVersion.length).toBeLessThanOrEqual(40);
  });

  it("stops at the first rule that blocks; in exhaustive mode lists every breach, the first one deciding", () => {
    const input = agentReply({ conversation: takenAt("2026-10-07T10:08:00-03:00"), request: { text: "Pagá tu cuota hoy y mandame tu clave" } });
    const first = evaluate(input);
    expect(outcome(first)).toEqual({ decision: "BLOCKED", ruleIds: ["CH-CONTROL"], errorCode: "CONTROL_OPERATOR" });
    expect(first.evaluated).toHaveLength(2);
    const every = evaluate(input, { exhaustive: true });
    expect(every.ruleIds).toEqual(["CH-CONTROL", "CH-WA-NO-COLLECTION", "CH-NO-SENSITIVE-ASK"]);
    expect(every.errorCode).toBe("CONTROL_OPERATOR");
  });

  it("a later block wins over an earlier deferral", () => {
    const decision = evaluate(proactiveUpdate({ at: "2026-10-07T21:00:00-03:00", request: { text: "Pasame el número de tarjeta" } }));
    expect(outcome(decision)).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-NO-SENSITIVE-ASK"] });
    expect(decision.evaluated.find((entry) => entry.ruleId === "CH-CONTACT-HOURS")?.result).toBe("DEFER");
  });

  it("never reads the machine's clock: the same input gives the same decision in any year", () => {
    const inputs = [agentReply(), proactiveUpdate({ at: "2026-10-10T18:00:00-03:00" }), operatorCompose(), formalNotice()];
    const before = inputs.map((input) => evaluate(input));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T03:00:00Z"));
    expect(inputs.map((input) => evaluate(input))).toEqual(before);
  });

  it("fails closed on a missing fact when deciding a send", () => {
    const decision = evaluate(agentReply({ history: undefined }));
    expect(outcome(decision)).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-OPTIN"] });
    expect(decision.reason).toContain("fails closed");
    expect(evaluate(proactiveUpdate({ history: undefined })).ruleIds).toEqual(["CH-MAX-PER-DAY"]);
    expect(outcome(evaluate(agentReply({ request: { auth: undefined } })))).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-SENDER"] });
    expect(() => evaluate({ ...agentReply(), request: { ...agentReply().request, kind: "NOT_A_KIND" as never } })).toThrow();
  });
});

describe("[FL-064] the operator's overdue reminder by WhatsApp", () => {
  it("[FL-064] blocks it with CH-WA-NO-COLLECTION and offers the human queue and the formal notice by email", () => {
    const decision = evaluate(operatorCompose());
    expect(outcome(decision)).toEqual({ decision: "BLOCKED", ruleIds: ["CH-WA-NO-COLLECTION"], errorCode: "POLICY_DENIED" });
    expect(decision.reroutes).toEqual([{ route: "HUMAN_QUEUE" }, { route: "FORMAL_EMAIL", previewKind: "COLLECTION_NOTICE_EMAIL" }]);
    expect(decision.evaluated.find((entry) => entry.ruleId === "CH-CONTROL")?.result).toBe("SKIP");
  });

  it("[FL-064] blocks the same reminder from the agent or the system, who only get the human queue", () => {
    for (const sender of ["AGENT", "SYSTEM"] as const) {
      const decision = evaluate(operatorCompose({ request: { sender, auth: { agentSessionValid: true } } }));
      expect(decision.ruleIds).toEqual(["CH-WA-NO-COLLECTION"]);
      expect(decision.reroutes).toEqual([{ route: "HUMAN_QUEUE" }]);
    }
  });

  it("[FL-064] the formal notice it is rerouted to goes out by email inside its hours, once every 7 days", () => {
    expect(outcome(evaluate(formalNotice()))).toEqual({ decision: "ALLOWED", ruleIds: expect.any(Array), errorCode: undefined });
    const second = evaluate(formalNotice({ history: [sent("msg-out-n1", "COLLECTION_NOTICE_EMAIL", "2026-10-02T10:00:00-03:00", { channel: "EMAIL" })] }));
    expect(outcome(second)).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-MAX-PER-DAY"] });
    const eightDaysLater = evaluate(formalNotice({ history: [sent("msg-out-n1", "COLLECTION_NOTICE_EMAIL", "2026-09-29T10:00:00-03:00", { channel: "EMAIL" })] }));
    expect(eightDaysLater.decision).toBe("ALLOWED");
  });

  it("[FL-064] the formal notice exists only as a reroute, rendered by code from the core", () => {
    expect(evaluate(formalNotice({ request: { rerouteOf: undefined } })).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
    expect(evaluate(formalNotice({ request: { text: "Pagá hoy" } })).ruleIds).toEqual(["CH-FORMAL-CONTENT"]);
    const wrongTotal = formalNotice().request.debtNotice;
    expect(evaluate(formalNotice({ request: { debtNotice: wrongTotal && { ...wrongTotal, totalCents: 1 } } })).ruleIds).toEqual(["CH-FORMAL-CONTENT"]);
    expect(evaluate(formalNotice({ request: { sender: "AGENT", auth: { agentSessionValid: true } } })).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
  });
});

describe("[FL-006] opt-out", () => {
  const OPT_OUT = "2026-10-07T10:00:00-03:00";

  it("[FL-006] blocks a proactive update after the opt-out and reroutes it to email", () => {
    const decision = evaluate(operatorCompose({ at: "2026-10-07T11:00:00-03:00", customer: optedOutAt(MARTIN, OPT_OUT), complaint: complaintOf(MARTIN), request: { kind: "COMPLAINT_UPDATE", complaintId: "cmp-0009", template: UPDATE_TEMPLATE } }));
    expect(outcome(decision)).toEqual({ decision: "BLOCKED", ruleIds: ["CH-OPTOUT"], errorCode: "POLICY_DENIED" });
    expect(decision.reroutes).toEqual([{ route: "HUMAN_QUEUE" }, { route: "FORMAL_EMAIL", previewKind: "COMPLAINT_UPDATE_EMAIL" }]);
  });

  it("[FL-006] the opt-out confirmation still goes out, and so do replies to a message written after it", () => {
    const history = [inbound("msg-in-stop", "2026-10-07T09:59:00-03:00")];
    const confirmation = agentReply({ customer: optedOutAt(VALERIA, OPT_OUT), history, request: { sender: "SYSTEM", kind: "OPT_OUT_CONFIRMATION", text: "Listo, no te vamos a mandar más mensajes por acá." } });
    expect(evaluate(confirmation).decision).toBe("ALLOWED");
    expect(evaluate(agentReply({ customer: optedOutAt(VALERIA, OPT_OUT), history })).ruleIds).toEqual(["CH-OPTOUT"]);
    expect(evaluate(agentReply({ customer: optedOutAt(VALERIA, OPT_OUT), history: [...history, inbound("msg-in-new", "2026-10-07T10:05:00-03:00")] })).decision).toBe("ALLOWED");
  });

  it("[FL-006] honours a current opt-out the history lags behind", () => {
    const lagging = { ...optedIn(VALERIA), optedOut: true };
    expect(evaluate(proactiveUpdate({ customer: lagging })).ruleIds).toEqual(["CH-OPTOUT"]);
  });
});

describe("[FL-007] customer without opt-in: replies inside the window, updates by email", () => {
  const rocio = { customer: withoutOptIn(ROCIO), complaint: complaintOf(ROCIO) };

  it("[FL-007] a reply inside the window the customer opened needs no opt-in", () => {
    const reply = agentReply({ ...rocio, request: { customerId: ROCIO, complaintId: "cmp-0038" } });
    expect(evaluate(reply).decision).toBe("ALLOWED");
  });

  it("[FL-007] a WhatsApp update 26 hours later is blocked by CH-OPTIN and rerouted to email, which goes out", () => {
    const update = operatorCompose({ ...rocio, at: "2026-10-08T12:04:00-03:00", history: [inbound("msg-in-01", "2026-10-07T10:04:00-03:00")], request: { customerId: ROCIO, complaintId: "cmp-0038", kind: "COMPLAINT_UPDATE", template: UPDATE_TEMPLATE } });
    const decision = evaluate(update);
    expect(outcome(decision)).toEqual({ decision: "BLOCKED", ruleIds: ["CH-OPTIN"], errorCode: "POLICY_DENIED" });
    expect(decision.reroutes).toContainEqual({ route: "FORMAL_EMAIL", previewKind: "COMPLAINT_UPDATE_EMAIL" });
    expect(evaluate(updateByEmail({ at: "2026-10-08T12:04:00-03:00" })).decision).toBe("ALLOWED");
    expect(evaluate(updateByEmail({ request: { rerouteOf: undefined } })).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
  });
});

describe("[FL-071] daily cap of proactive contacts", () => {
  const today = [
    sent("msg-o1", "COMPLAINT_UPDATE", "2026-10-07T08:30:00-03:00"),
    sent("msg-o2", "HANDOFF_NOTICE", "2026-10-07T09:00:00-03:00"),
    sent("msg-o3", "COMPLAINT_UPDATE", "2026-10-07T09:30:00-03:00", { channel: "EMAIL" }),
  ];

  it("[FL-071] defers the fourth proactive contact of the day, adding both channels, to the next day's opening", () => {
    const decision = evaluate(proactiveUpdate({ history: today }));
    expect(outcome(decision)).toEqual({ decision: "DEFERRED", ruleIds: ["CH-MAX-PER-DAY"], errorCode: "DEFERRED" });
    expect(decision.nextAllowedAt).toBe("2026-10-08T08:00:00-03:00");
    expect(evaluate(proactiveUpdate({ history: today, at: decision.nextAllowedAt })).decision).toBe("ALLOWED");
  });

  it("[FL-071] replies, written answers and messages that never went out do not count", () => {
    const quiet = [
      sent("msg-o1", "REPLY", "2026-10-07T08:30:00-03:00", { proactive: false }),
      sent("msg-o2", "FORMAL_ANSWER", "2026-10-07T09:00:00-03:00", { channel: "EMAIL" }),
      sent("msg-o3", "COMPLAINT_UPDATE", "2026-10-07T09:30:00-03:00", { status: "BLOCKED" }),
      sent("msg-o4", "COMPLAINT_UPDATE", "2026-10-06T09:30:00-03:00"),
      sent("msg-o5", "COMPLAINT_UPDATE", "2026-10-07T09:40:00-03:00"),
      sent("msg-o6", "RESOLUTION_NOTICE", "2026-10-07T09:50:00-03:00"),
    ];
    expect(evaluate(proactiveUpdate({ history: quiet })).decision).toBe("ALLOWED");
    expect(evaluate(agentReply({ history: [...today, inbound("msg-in-01", "2026-10-07T10:04:00-03:00")] })).decision).toBe("ALLOWED");
  });
});

describe("[FL-072] credit offers", () => {
  it("[FL-072] blocks an offer on WhatsApp and on email, without a reroute", () => {
    const offer = "¿Querés un préstamo nuevo con tasa preferencial?";
    const whatsapp = evaluate(agentReply({ conversation: takenAt("2026-10-07T10:08:00-03:00"), request: { sender: OPERATOR, auth: { staff: OPERATOR_STAFF }, text: offer } }));
    expect(outcome(whatsapp)).toEqual({ decision: "BLOCKED", ruleIds: ["CH-NO-CREDIT-OFFER"], errorCode: "POLICY_DENIED" });
    expect(whatsapp.reroutes).toBeUndefined();
    const email = evaluate(updateByEmail({ request: { text: `Novedad de tu reclamo. ${offer}` } }));
    expect(email.ruleIds).toEqual(["CH-NO-CREDIT-OFFER"]);
  });

  it("[FL-072] a refusal that names what it does not offer passes", () => {
    expect(evaluate(agentReply({ request: { kind: "OUT_OF_SCOPE_REFUSAL", text: "Por este canal no ofrecemos créditos ni refinanciaciones. Si querés, te paso con una persona." } })).decision).toBe("ALLOWED");
  });
});

describe("[FL-074] proactive WhatsApp without an open complaint", () => {
  it("[FL-074] blocks a reclamo_novedad template to a customer without an open complaint", () => {
    const noComplaint = operatorCompose({ request: { kind: "COMPLAINT_UPDATE", template: UPDATE_TEMPLATE } });
    expect(outcome(evaluate(noComplaint))).toEqual({ decision: "BLOCKED", ruleIds: ["CH-WA-CUSTOMER-INITIATED"], errorCode: "POLICY_DENIED" });
    const closed = proactiveUpdate({ complaint: complaintOf(VALERIA, { status: "CLOSED" }) });
    expect(evaluate(closed).ruleIds).toEqual(["CH-WA-CUSTOMER-INITIATED"]);
    const someoneElses = proactiveUpdate({ complaint: complaintOf(MARTIN, { complaintId: "cmp-0001" }) });
    expect(evaluate(someoneElses).ruleIds).toEqual(["CH-WA-CUSTOMER-INITIATED"]);
    expect(evaluate(proactiveUpdate()).decision).toBe("ALLOWED");
  });
});

describe("sender, control and the kind → channel matrix", () => {
  it("CH-SENDER: a valid session, a current sending role in the world, or a deterministic SYSTEM kind", () => {
    expect(evaluate(agentReply({ request: { auth: { agentSessionValid: false } } })).ruleIds).toEqual(["CH-SENDER"]);
    const staff = (patch: Partial<typeof OPERATOR_STAFF> | Record<string, unknown>) => operatorCompose({ request: { kind: "COMPLAINT_UPDATE", template: UPDATE_TEMPLATE, auth: { staff: { ...OPERATOR_STAFF, ...patch } as typeof OPERATOR_STAFF } } });
    expect(evaluate(staff({ role: "COMPLIANCE" })).ruleIds).toEqual(["CH-SENDER"]);
    expect(evaluate(staff({ worldId: "g01" })).ruleIds).toEqual(["CH-SENDER"]);
    expect(evaluate(staff({ active: false })).ruleIds).toEqual(["CH-SENDER"]);
    expect(evaluate(staff({ staffId: "stf-operator-02" })).ruleIds).toEqual(["CH-SENDER"]);
    expect(evaluate(agentReply({ request: { sender: "SYSTEM", kind: "IDENTITY_CHALLENGE" } })).ruleIds).toEqual(["CH-SENDER"]);
    // A fixed reply of copy/ inside the window is SYSTEM's own REPLY.
    expect(evaluate(agentReply({ request: { sender: "SYSTEM" } })).decision).toBe("ALLOWED");
  });

  it("CH-CONTROL: the agent stops when a person takes over; an operator writes free text only with the conversation taken", () => {
    expect(outcome(evaluate(agentReply({ conversation: takenAt("2026-10-07T10:08:00-03:00") })))).toEqual({ decision: "BLOCKED", ruleIds: ["CH-CONTROL"], errorCode: "CONTROL_OPERATOR" });
    const operatorText = { sender: OPERATOR, auth: { staff: OPERATOR_STAFF } } as const;
    expect(evaluate(agentReply({ request: operatorText })).ruleIds).toEqual(["CH-CONTROL"]);
    expect(evaluate(agentReply({ request: operatorText, conversation: takenAt("2026-10-07T10:08:00-03:00") })).decision).toBe("ALLOWED");
    expect(evaluate(agentReply({ request: operatorText, conversation: takenAt("2026-10-07T10:08:00-03:00", "OPERATOR:stf-operator-02") })).ruleIds).toEqual(["CH-CONTROL"]);
    expect(evaluate(agentReply({ conversation: { control: "OPERATOR", controlHistory: [] } })).ruleIds).toEqual(["CH-CONTROL"]);
  });

  it("CH-KIND-CHANNEL: written answers and certificates only by email; staff alerts only from demo", () => {
    expect(evaluate(agentReply({ request: { kind: "FORMAL_ANSWER" } })).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
    expect(evaluate(agentReply({ request: { attachments: ["PAYOFF_CERTIFICATE"] } })).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
    expect(evaluate(agentReply({ request: { kind: "HANDOFF_NOTICE" } })).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
    const alert = updateByEmail({ request: { sender: "SYSTEM", kind: "SUPERVISOR_ALERT", rerouteOf: undefined, worldId: "g01", to: "success+g01-supervisor@simulator.amazonses.com", text: "Hito de escalamiento" } });
    expect(evaluate(alert).ruleIds).toEqual(["CH-KIND-CHANNEL"]);
  });
});

describe("recipient fence per world", () => {
  const email = (worldId: string, to: string, extra: Record<string, unknown> = {}) => evaluate(updateByEmail({ request: { worldId, to, auth: { staff: { ...OPERATOR_STAFF, worldId } }, ...extra } }));

  it("email reaches the SES simulator from any world, and a registered demo recipient only from demo", () => {
    expect(email("g01", `success+g01-${ROCIO}@simulator.amazonses.com`).decision).toBe("ALLOWED");
    expect(email("demo", "demo.recipient@craftech.io").decision).toBe("ALLOWED");
    expect(outcome(email("g01", "demo.recipient@craftech.io"))).toEqual({ decision: "BLOCKED", ruleIds: ["CH-RECIPIENT-FENCE"], errorCode: "RECIPIENT_NOT_ALLOWED" });
    expect(outcome(email("demo", "other.person@craftech.io"))).toMatchObject({ ruleIds: ["CH-RECIPIENT-FENCE"] });
  });

  it("refuses deceptive, reserved and multiple recipients", () => {
    for (const to of ["success@simulator.amazonses.com.example.net", "SUCCESS@simulator.amazonses.com", "customer@example.com", "x@reclamo.test", "nobody@simulator.amazonses.com", "success+@simulator.amazonses.com", "a@b@simulator.amazonses.com", "\"success\"@simulator.amazonses.com"]) {
      expect(email("demo", to).ruleIds, to).toEqual(["CH-RECIPIENT-FENCE"]);
    }
    expect(email("demo", `success+${ROCIO}@simulator.amazonses.com`, { cc: [`success+cc@simulator.amazonses.com`] }).ruleIds).toEqual(["CH-RECIPIENT-FENCE"]);
  });

  it("live WhatsApp only from a world that may run live and only to a registered demo phone", () => {
    const live = { modes: { whatsapp: "live" as const, email: "live" as const } };
    expect(evaluate(agentReply({ ...live, request: { to: "+5491100009999" } })).decision).toBe("ALLOWED");
    expect(evaluate(agentReply({ ...live, request: { to: "+5491100001001" } })).ruleIds).toEqual(["CH-RECIPIENT-FENCE"]);
    expect(evaluate(agentReply({ ...live, request: { worldId: "g01", to: "+5491100009999" } })).ruleIds).toEqual(["CH-RECIPIENT-FENCE"]);
    expect(evaluate(agentReply({ request: { worldId: "g01" } })).decision).toBe("ALLOWED");
  });
});

describe("content rules", () => {
  it("a payment request by WhatsApp is CH-WA-NO-PAYMENT-REQUEST, and a full CVU is also sensitive data", () => {
    const draft = agentReply({ request: { text: "Podés pagar el saldo al CVU 9990000000000000000012" } });
    expect(outcome(evaluate(draft))).toEqual({ decision: "BLOCKED", ruleIds: ["CH-WA-NO-PAYMENT-REQUEST"], errorCode: "POLICY_DENIED" });
    expect(evaluate(draft, { exhaustive: true }).ruleIds).toEqual(["CH-WA-NO-PAYMENT-REQUEST", "CH-NO-SENSITIVE-ASK"]);
  });

  it("no request for credentials, cards or documents; the safety text that says we never ask passes", () => {
    expect(evaluate(agentReply({ request: { text: "Para seguir, pasame tu clave y el código que te llegó por SMS" } })).ruleIds).toEqual(["CH-NO-SENSITIVE-ASK"]);
    expect(evaluate(agentReply({ request: { text: "Mandame una foto de tu DNI" } })).ruleIds).toEqual(["CH-NO-SENSITIVE-ASK"]);
    const safety = agentReply({ request: { sender: "SYSTEM", kind: "SAFETY_GUIDANCE", text: "Nunca te vamos a pedir claves, PIN, códigos ni datos de tarjetas." } });
    expect(evaluate(safety).decision).toBe("ALLOWED");
  });

  it("no foreign links, emails or phones; the stage's domain and masked records are fine", () => {
    expect(evaluate(agentReply({ request: { text: "Escribinos a ayuda@jarilla-ficticia.com" } })).ruleIds).toEqual(["CH-NO-FOREIGN-LINKS"]);
    expect(evaluate(agentReply({ request: { text: "Mirá https://otro-sitio.com/pago" } }), { exhaustive: true }).ruleIds).toContain("CH-NO-FOREIGN-LINKS");
    expect(evaluate(agentReply({ request: { text: "Llamanos al 11 5555 0101" } })).ruleIds).toEqual(["CH-NO-FOREIGN-LINKS"]);
    expect(evaluate(agentReply({ request: { text: "Te mandamos la respuesta a v•••@… y la ves en https://reclamo.demo.craftech.io/app" } })).decision).toBe("ALLOWED");
  });

  it("the written answer carries number, type, filing date and resolution", () => {
    const answer = updateByEmail({ request: { sender: "AGENT", auth: { agentSessionValid: true }, kind: "FORMAL_ANSWER", rerouteOf: undefined, text: "Tu pago quedó imputado a la cuota 4.", formal: { outcome: "IN_FAVOUR" } } });
    expect(evaluate(answer).decision).toBe("ALLOWED");
    expect(evaluate({ ...answer, request: { ...answer.request, formal: undefined } }).ruleIds).toEqual(["CH-FORMAL-CONTENT"]);
    expect(evaluate({ ...answer, complaint: complaintOf(MARTIN) }).ruleIds).toEqual(["CH-FORMAL-CONTENT"]);
  });
});
