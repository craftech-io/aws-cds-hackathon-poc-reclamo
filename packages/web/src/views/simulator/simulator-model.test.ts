// The phone simulator's rules (FL-101): the English gloss of what the phone shows, the next script
// line, the checks of a test image before its presigned upload, the ticks and the persona filter.
import { describe, expect, it } from "vitest";
import { AUTOMATED_DISCLOSURE, WHATSAPP_TEXT } from "@reclamo/bff/copy/es-AR";
import { MAX_MEDIA_BYTES } from "@reclamo/bff/channels/whatsapp/config";
import type { SimMessage, SimPersona } from "./simulator-api";
import { buttonGlossOf, chronological, filterPersonas, noteArrivals, glossLine, glossOf, imageProblem, nextScriptIndex, ticksOf } from "./simulator-model";

const ACK = [
  AUTOMATED_DISCLOSURE,
  "Registré tu reclamo R-2026-000123 (pago no reflejado). La respuesta escrita te llega a más tardar el jueves 22/10.",
  "¿Aceptás que la respuesta escrita de este reclamo y sus documentos te lleguen por email a s***@simulator.amazonses.com? Si preferís otro medio, te contacta una persona.",
].join("\n");

function message(overrides: Partial<SimMessage>): SimMessage {
  return { messageId: "msg-1", direction: "OUT", body: "", templateName: null, buttons: [], image: null, status: "DELIVERED", atSim: "2026-10-07T10:10:00-03:00", ...overrides };
}

const VALERIA: SimPersona = {
  persona: "C01",
  customerId: "cus-0001",
  name: "Valeria Quiroga",
  phoneMasked: "+54 9 11 ••••-0001",
  scenario: "Pago no reflejado, lote pendiente (historia principal)",
  scenarioEn: "Payment not reflected, batch pending (main story)",
  script: [
    { text: "Pagué la cuota 4", en: "I paid instalment 4", receipt: true },
    { text: "¿Ya figura?", en: "Is it there yet?", receipt: false },
  ],
  hasReceipt: true,
};

describe("the English gloss of the phone [FL-101]", () => {
  it("glosses every fixed line of the acknowledgement, with its values and the complaint type in English", () => {
    const gloss = glossOf(message({ body: ACK, buttons: [{ index: 0, action: "ACCEPT_EMAIL", title: "Sí, a ese email" }, { index: 1, action: "TALK_TO_HUMAN", title: "Hablar con alguien" }] }));
    expect(gloss.lines).toEqual([
      "I am the automated assistant of Jarilla (fictitious). At any time you can ask to be served by a person.",
      "I registered your complaint R-2026-000123 (payment not reflected). The written answer reaches you no later than jueves 22/10.",
      expect.stringMatching(/^Do you accept that the written answer .* by email at s\*\*\*@simulator\.amazonses\.com\?/),
    ]);
    expect(gloss.buttons).toEqual(["Yes, to that email", "Talk to someone"]);
  });

  it("glosses a template with its status phrase, leaves the agent's free text without a gloss and an inbound script line by its script", () => {
    expect(glossLine("Hola Valeria, hay una novedad en tu reclamo R-2026-000123: ya tenemos la rendición de la red. Podés responder por acá.")).toMatch(/^Hello Valeria, there is an update on your complaint R-2026-000123: /);
    expect(glossLine(WHATSAPP_TEXT.RECEIPT_REQUEST)).toBe("Send me a photo of the receipt so I can review it.");
    expect(glossOf(message({ body: "Ya revisé tu cuota y quedó al día." })).lines).toEqual([undefined]);
    expect(glossOf(message({ direction: "IN", body: "Pagué la cuota 4" }), new Map([["Pagué la cuota 4", "I paid instalment 4"]])).lines).toEqual(["I paid instalment 4"]);
    expect(buttonGlossOf("TALK_TO_HUMAN", "Hablar con una persona")).toBe("Talk to a person");
  });
});

describe("the persona's script [FL-101]", () => {
  it("offers the first line the persona has not sent yet, and nothing once all were sent", () => {
    expect(nextScriptIndex(VALERIA, [])).toBe(0);
    expect(nextScriptIndex(VALERIA, [message({ direction: "IN", body: "Pagué la cuota 4" }), message({ body: "Pagué la cuota 4" })])).toBe(1);
    expect(nextScriptIndex(VALERIA, [message({ direction: "IN", body: "Pagué la cuota 4" }), message({ direction: "IN", body: "¿Ya figura?" })])).toBeUndefined();
  });

  it("filters the personas by id, name or scenario in either language, accents ignored", () => {
    const personas = [VALERIA, { ...VALERIA, persona: "C07", name: "Florencia Ledesma", scenario: "Comprobante falso", scenarioEn: "Fake receipt" }];
    expect(filterPersonas(personas, "c07").map((persona) => persona.persona)).toEqual(["C07"]);
    expect(filterPersonas(personas, "historia principal").map((persona) => persona.persona)).toEqual(["C01"]);
    expect(filterPersonas(personas, "fake").map((persona) => persona.persona)).toEqual(["C07"]);
    expect(filterPersonas(personas, "valeria").map((persona) => persona.persona)).toEqual(["C01"]);
    expect(filterPersonas(personas, "  ")).toHaveLength(2);
  });
});

describe("a test image before its presigned upload [FL-101]", () => {
  it("accepts a JPG or PNG of 1 byte to 3.75 MB and names why anything else is refused", () => {
    expect(imageProblem({ size: 1, type: "image/png" })).toBeUndefined();
    expect(imageProblem({ size: MAX_MEDIA_BYTES, type: "image/jpeg" })).toBeUndefined();
    expect(imageProblem({ size: MAX_MEDIA_BYTES + 1, type: "image/jpeg" })).toBe("TOO_LARGE");
    expect(imageProblem({ size: 0, type: "image/png" })).toBe("EMPTY");
    expect(imageProblem({ size: 100, type: "application/pdf" })).toBe("UNSUPPORTED");
  });
});

describe("the ticks of an outbound message", () => {
  it("draws sent, delivered, read and failed, and none for the persona's own messages", () => {
    expect(ticksOf(message({ status: "SENT" }))).toEqual({ symbol: "✓", read: false });
    expect(ticksOf(message({ status: "DELIVERED" }))).toEqual({ symbol: "✓✓", read: false });
    expect(ticksOf(message({ status: "READ" }))).toEqual({ symbol: "✓✓", read: true });
    expect(ticksOf(message({ status: "FAILED" }))?.symbol).toBe("!");
    expect(ticksOf(message({ direction: "IN", status: "RECEIVED" }))).toBeUndefined();
  });
});

describe("the order of the thread [FL-101]", () => {
  it("follows the simulated time, then the real instant it was stored, then the persona's message before its answers", () => {
    const at = "2026-10-07T10:10:00-03:00";
    const thread = [
      message({ messageId: "msg-l000009", atSim: at }),
      message({ messageId: "wa-in-ffff", direction: "IN", atSim: at }),
      message({ messageId: "msg-l000003", atSim: "2026-10-07T10:05:00-03:00" }),
      message({ messageId: "msg-l000004", atSim: at }),
    ];
    expect(chronological(thread).map((item) => item.messageId)).toEqual(["msg-l000003", "wa-in-ffff", "msg-l000004", "msg-l000009"]);
    const stored = [message({ messageId: "b", atSim: at, createdAt: "2026-10-07T13:10:02Z" }), message({ messageId: "a", direction: "IN", atSim: at, createdAt: "2026-10-07T13:10:05Z" })];
    expect(chronological(stored).map((item) => item.messageId)).toEqual(["b", "a"]);
  });

  it("orders the messages of a paused minute by when the page first saw them", () => {
    const at = "2026-10-07T10:10:00-03:00";
    const firstSeen = new Map<string, number>();
    const ack = message({ messageId: "msg-zzz", atSim: at });
    const inbound = message({ messageId: "wa-in-1", direction: "IN", atSim: at });
    noteArrivals(firstSeen, [ack, inbound]);
    const holding = message({ messageId: "msg-aaa", atSim: at });
    noteArrivals(firstSeen, [ack, inbound, holding]);
    expect(chronological([holding, ack, inbound], firstSeen).map((item) => item.messageId)).toEqual(["wa-in-1", "msg-zzz", "msg-aaa"]);
  });
});
