import type { SendWhatsAppMessageInput } from "@aws-sdk/client-socialmessaging";
import { describe, expect, it } from "vitest";
import { ChannelError, ToolError } from "@reclamo/shared";
import { TemplateParamNotAllowedError } from "../../copy";
import { TEST_NOW } from "../../connector/testing";
import { fixedClock } from "../../lib/clock";
import { META_API_VERSION } from "./config";
import { liveWhatsAppTransport, toChannelError } from "./live-transport";
import { type WaOutbound, eumMessageBytes, noncesOf, renderedTextOf, toMetaMessage } from "./meta-message";
import { fixture } from "./testing";

const TO = "+5491100009001";
const N = (n: number) => `01K6ZT0000NONCE000000000${n}`;

const BAJA: WaOutbound = {
  kind: "buttons",
  body: "¿Querés dejar de recibir mensajes por WhatsApp o dar de baja tu cuenta de Jarilla?",
  buttons: [
    { id: N(1), title: "No recibir mensajes" },
    { id: N(2), title: "Baja de mi cuenta" },
  ],
};
const LOANS: WaOutbound = {
  kind: "list",
  body: "Tenés más de un préstamo. ¿Sobre cuál es tu reclamo?",
  buttonTitle: "Elegir préstamo",
  rows: [
    { id: N(3), title: "Préstamo personal 0001", description: "12 cuotas" },
    { id: N(4), title: "Préstamo express 0002" },
  ],
};
const NOVEDAD: WaOutbound = { kind: "template", name: "reclamo_novedad", values: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"], nonces: [N(5), N(6)] };

describe("Meta messages [FL-103]", () => {
  it("[FL-103] builds text, buttons, list and template exactly as the snapshots", () => {
    expect(toMetaMessage({ kind: "text", body: "Recibimos tu mensaje." }, TO)).toEqual(fixture("send-text.json"));
    expect(toMetaMessage(BAJA, TO)).toEqual(fixture("send-buttons.json"));
    expect(toMetaMessage(LOANS, TO)).toEqual(fixture("send-list.json"));
    expect(toMetaMessage(NOVEDAD, TO)).toEqual(fixture("send-template.json"));
    expect(noncesOf(toMetaMessage(NOVEDAD, TO))).toEqual([N(5), N(6)]);
    expect(renderedTextOf(NOVEDAD)).toBe("Hola Valeria, hay una novedad en tu reclamo R-2026-000123: ya tenemos la rendición de la red. Podés responder por acá.");
  });

  it("[FL-103] refuses a reply button over 20 characters, a list row over 24 and more than three buttons", () => {
    expect(() => toMetaMessage({ kind: "buttons", body: "x", buttons: [{ id: N(1), title: "Hablar con una persona" }] }, TO)).toThrow();
    expect(() => toMetaMessage({ ...LOANS, rows: [{ id: N(3), title: "Préstamo personal número 0001" }] } as WaOutbound, TO)).toThrow();
    const four = [1, 2, 3, 4].map((n) => ({ id: N(n), title: `Opción ${n}` }));
    expect(() => toMetaMessage({ kind: "buttons", body: "x", buttons: four }, TO)).toThrow();
  });

  it("[FL-103] fills {{3}} only from the closed list of status phrases", () => {
    expect(() => toMetaMessage({ ...NOVEDAD, values: ["Valeria", "R-2026-000123", "pagá hoy"] }, TO)).toThrow(TemplateParamNotAllowedError);
    expect(() => toMetaMessage({ ...NOVEDAD, nonces: [N(5)] }, TO)).toThrow(RangeError);
  });

  it("[FL-103] sends the recipient in E.164 to End User Messaging Social and Meta's digits everywhere else", () => {
    const message = toMetaMessage({ kind: "text", body: "hola" }, TO);
    expect(message.to).toBe("5491100009001");
    expect(JSON.parse(new TextDecoder().decode(eumMessageBytes(message))).to).toBe("+5491100009001");
  });
});

describe("live transport [FL-103]", () => {
  const record = { worldId: "demo", customerId: "cus-0004", messageId: "msg-out-7" };
  const setup = (options: { live?: boolean; number?: string; template?: string; fail?: Error[] } = {}) => {
    const sent: SendWhatsAppMessageInput[] = [];
    const failures = [...(options.fail ?? [])];
    const transport = liveWhatsAppTransport({
      phoneNumberId: "phone-number-id-0123456789abcdef0123456789abcdef",
      allowedPhones: ["+54 9 11 0000-9001"],
      isLiveWorld: async () => options.live ?? true,
      recipients: { whatsAppNumber: async () => options.number ?? TO },
      templates: { status: async () => options.template ?? "APPROVED" },
      eum: {
        send: async (input) => {
          const failure = failures.shift();
          if (failure !== undefined) throw failure;
          sent.push(input);
          return { messageId: "eum-message-id-1" };
        },
      },
      realClock: fixedClock(TEST_NOW),
      retry: { sleep: async () => undefined },
    });
    return { transport, sent };
  };

  it("[FL-103] sends the exact JSON with the fixed API version to a registered demo number", async () => {
    const { transport, sent } = setup();
    const result = await transport.send({ record, outbound: BAJA });
    expect(result).toMatchObject({ providerMessageId: "eum-message-id-1", simulated: false, status: "SENT" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metaApiVersion).toBe(META_API_VERSION);
    expect(sent[0]?.originationPhoneNumberId).toBe("phone-number-id-0123456789abcdef0123456789abcdef");
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.message))).toEqual({ ...(fixture("send-buttons.json") as object), to: "+5491100009001" });
  });

  it("[FL-103] keeps the recipient fence inside the transport", async () => {
    await expect(setup({ number: "+5491155550000" }).transport.send({ record, outbound: BAJA })).rejects.toThrow(ToolError);
    await expect(setup({ live: false }).transport.send({ record, outbound: BAJA })).rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
    await expect(setup({ number: "" }).transport.send({ record, outbound: BAJA })).rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
  });

  it("[FL-103] never sends a template Meta has not approved", async () => {
    const { transport, sent } = setup({ template: "PENDING" });
    await expect(transport.send({ record, outbound: NOVEDAD })).rejects.toThrow(/not APPROVED/);
    expect(sent).toHaveLength(0);
  });

  it("does not exist while the number is not configured", () => {
    expect(() => liveWhatsAppTransport({ ...({} as Parameters<typeof liveWhatsAppTransport>[0]), phoneNumberId: "not-connected", allowedPhones: [] })).toThrow(ChannelError);
  });

  it("retries a throttled send but never a timed-out one (it could reach the customer twice)", async () => {
    const throttled = Object.assign(new Error("slow down"), { name: "ThrottledRequestException" });
    const { transport, sent } = setup({ fail: [throttled] });
    await transport.send({ record, outbound: BAJA });
    expect(sent).toHaveLength(1);
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const second = setup({ fail: [timeout] });
    await expect(second.transport.send({ record, outbound: BAJA })).rejects.toMatchObject({ code: "TIMEOUT", retryable: false });
    expect(second.sent).toHaveLength(0);
    expect(toChannelError(Object.assign(new Error("x"), { name: "ValidationException" }), "op", true).code).toBe("INVALID");
  });
});
