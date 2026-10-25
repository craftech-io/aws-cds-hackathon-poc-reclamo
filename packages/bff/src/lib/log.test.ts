import { describe, expect, it } from "vitest";
import { ChannelError, ConnectorError } from "@reclamo/shared";
import { MASK, correlationIdFrom, createLogger, redactFields, redactText } from "./log";

function capture(level: "debug" | "info" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ correlationId: "corr-0001-test", level, sink: (line) => lines.push(line), now: () => new Date("2026-09-08T13:00:00Z"), bindings: { service: "inbound-whatsapp" } });
  return { logger, lines, last: (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("logger", () => {
  it("writes one JSON line with level, time, correlation id and bindings", () => {
    const { logger, lines, last } = capture();
    logger.info("turn finished", { turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
    expect(lines).toHaveLength(1);
    expect(last()).toEqual({ level: "info", time: "2026-09-08T13:00:00.000Z", correlationId: "corr-0001-test", message: "turn finished", service: "inbound-whatsapp", turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
  });

  it("carries the correlation id into child loggers and respects the level", () => {
    const { logger, lines, last } = capture("info");
    const child = logger.child({ tool: "get_account" });
    child.debug("not written");
    child.warn("slow call");
    expect(lines).toHaveLength(1);
    expect(last()).toMatchObject({ level: "warn", correlationId: "corr-0001-test", service: "inbound-whatsapp", tool: "get_account" });
    expect(child.correlationId).toBe(logger.correlationId);
  });

  it("[FL-050] masks E.164 numbers and emails wherever they appear", () => {
    const { logger, last, lines } = capture();
    logger.info("inbound from +54 9 11 0000-1001 and cliente.c01@example.test", { phoneE164: "+5491100001001", email: "cliente.c01@example.test", address: "+5491100001002", to: "success+c01@simulator.amazonses.com", note: "llamar al +54 9 11 0000 1002" });
    expect(last()).toMatchObject({ message: `inbound from ${MASK.phone} and ${MASK.email}`, phoneE164: MASK.phone, email: MASK.email, address: MASK.phone, to: MASK.email, note: `llamar al ${MASK.phone}` });
    expect(lines[0]).not.toMatch(/0000[- ]?100[12]|cliente\.c01|simulator/);
  });

  it("[FL-050] masks documents, cards, secrets, names and amounts", () => {
    const { logger, last, lines } = capture();
    logger.info("statement built", {
      displayName: "Nora Quintana", document: "27-14555666-3", cuitInText: "CUIT 27-14555666-3 DNI 1020304050 clave 4821", instalment: { amount: 118_640, text: "$ 118.640,00" },
      totalPending: 66_820_000, text: "El saldo es $ 668.200,00", summary: "saldo $ 668.200,00 y tarjeta 4111 1111 1111 1111", complaintId: "cmp-4471",
    });
    expect(last()).toMatchObject({
      displayName: MASK.name, document: MASK.document, cuitInText: `CUIT [CUIT] DNI ${MASK.number} clave [CLAVE]`, instalment: MASK.amount, totalPending: MASK.amount,
      text: MASK.omitted, summary: `saldo ${MASK.amount} y tarjeta [TARJETA]`, complaintId: "cmp-4471",
    });
    expect(lines[0]).not.toMatch(/668|118|Quintana|14555666|4821|4111/);
  });

  it("drops raw provider events and tool results, keeps hashes, ids and instants", () => {
    const { logger, last } = capture();
    const addressHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    logger.debug("sns event", { event: { Records: [{ Sns: { Message: "{...}" } }] }, toolResult: { ok: true, total: 1 }, addressHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-09-08T10:00:00-03:00", expiresAt: 1788872400000, sizeBytes: 4_500_000 });
    expect(last()).toMatchObject({ event: MASK.omitted, toolResult: MASK.omitted, addressHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-09-08T10:00:00-03:00", expiresAt: 1788872400000, sizeBytes: 4_500_000 });
  });

  it("serialises typed errors with their code and a redacted message", () => {
    const { logger, last } = capture();
    const cause = new ConnectorError("THROTTLED", "table throttled", "Conversations");
    logger.error("send failed", { error: new ChannelError("SEND_FAILED", "WHATSAPP", "cannot reach +5491100001001", { cause }) });
    expect(last().error).toMatchObject({ name: "ChannelError", code: "SEND_FAILED", channel: "WHATSAPP", retryable: true, message: `cannot reach ${MASK.phone}`, cause: { name: "ConnectorError", code: "THROTTLED", table: "Conversations" } });
  });

  it("survives circular structures, huge strings and deep nesting", () => {
    const { logger, last } = capture();
    const circular: Record<string, unknown> = { id: "a" };
    circular.self = circular;
    logger.info("odd input", { circular, long: "x".repeat(5_000), deep: { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } } });
    const record = last();
    expect(JSON.stringify(record)).toContain("truncated 3000");
    expect(JSON.stringify(record.deep)).toContain(MASK.omitted);
    expect(record.message).toBe("odd input");
  });

  it("does not let a field overwrite the envelope", () => {
    const { logger, last } = capture();
    logger.info("real message", { level: "debug", correlationId: "spoofed" });
    expect(last()).toMatchObject({ level: "info", correlationId: "corr-0001-test", field_level: "debug", field_correlationId: "spoofed" });
  });
});

describe("redaction helpers", () => {
  it("leaves dates and ids alone", () => {
    expect(redactText("2026-09-08T10:00:00-03:00")).toBe("2026-09-08T10:00:00-03:00");
    expect(redactText("doc-cmp-4471-PAYOFF_CERTIFICATE-1 on 2026-10-14")).toBe("doc-cmp-4471-PAYOFF_CERTIFICATE-1 on 2026-10-14");
    expect(redactText("reclamo R-2026-000123, cuota 3")).toBe("reclamo R-2026-000123, cuota 3");
  });

  it("masks long free-standing digit runs and formatted money", () => {
    expect(redactText("DNI 1020304050 pagó $486.000")).toBe(`DNI ${MASK.number} pagó ${MASK.amount}`);
    expect(redactText("DNI 30.123.456")).toBe("DNI [DNI]");
    expect(redactFields({ nested: [{ email: "a@b.co" }], count: 12, price: 0.02 })).toEqual({ nested: [{ email: MASK.email }], count: 12, price: MASK.amount });
  });

  it("only reuses a correlation id that looks like one", () => {
    expect(correlationIdFrom("corr-0001-test")).toBe("corr-0001-test");
    expect(correlationIdFrom('x"}\n{"level":"error"')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
