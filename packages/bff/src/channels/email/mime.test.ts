// The raw MIME of a customer email: deterministic bytes, one `To`, no `Cc`/`Bcc`/`Reply-To`/`Message-ID`,
// text and HTML alternatives and the PDF attachments exactly as given (FL-011), and a MIME that names
// any other recipient never passes the single-recipient check (FL-073).
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { EMAIL_TEXT } from "../../copy";
import { sha256Hex } from "../../lib/crypto";
import { ANSWERS_ADDRESS, MAX_ATTACHMENTS_BYTES, worldObjectRoot } from "./config";
import { renderEmailContent } from "./content";
import { type MimeInput, buildMime, inspectMime, rfc5322Date } from "./mime";
import { assertSingleRecipient } from "./recipient-fence";
import { PDF_BYTES, TEST_MAIL_ID } from "./testing";

function input(overrides: Partial<MimeInput> = {}): MimeInput {
  return {
    from: { displayName: EMAIL_TEXT.FROM_NAME, address: ANSWERS_ADDRESS },
    to: "success+g01-cus-0001@simulator.amazonses.com",
    subject: "Reclamo R-2026-000123 · Acuse de recibo",
    date: new Date("2026-10-07T10:10:00-03:00"),
    mailId: TEST_MAIL_ID,
    worldId: "g01",
    text: "Hola Ana:\n\nRegistramos tu reclamo R-2026-000123 (pago no reflejado).",
    html: "<p>Hola Ana:</p><p>Registramos tu reclamo R-2026-000123.</p>",
    attachments: [{ filename: "acuse-R-2026-000123.pdf", bytes: PDF_BYTES }],
    ...overrides,
  };
}

function headerBlock(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  return text.slice(0, text.indexOf("\r\n\r\n"));
}

describe("raw MIME of a customer email [FL-011]", () => {
  it("is deterministic: the same input gives the same bytes and SHA-256", () => {
    const first = buildMime(input());
    const second = buildMime(input());
    expect(Buffer.from(first.raw).equals(Buffer.from(second.raw))).toBe(true);
    expect(first.sha256).toBe(sha256Hex(first.raw));
    expect(first.sha256).toBe(second.sha256);
    expect(buildMime(input({ mailId: "01JZ0000000000000000000002" })).sha256).not.toBe(first.sha256);
  });

  it("parses back to one To, the sender, the subject, both alternatives and the PDF", async () => {
    const { raw } = buildMime(input());
    const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
    expect(email.from).toEqual({ name: EMAIL_TEXT.FROM_NAME, address: ANSWERS_ADDRESS });
    expect(email.to).toEqual([{ name: "", address: "success+g01-cus-0001@simulator.amazonses.com" }]);
    expect(email.cc).toBeUndefined();
    expect(email.bcc).toBeUndefined();
    expect(email.replyTo).toBeUndefined();
    expect(email.messageId).toBeUndefined();
    expect(email.subject).toBe("Reclamo R-2026-000123 · Acuse de recibo");
    expect(email.text?.replace(/\r\n/g, "\n")).toBe(input().text);
    expect(email.html?.replace(/\r\n/g, "\n")).toBe(input().html);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ filename: "acuse-R-2026-000123.pdf", mimeType: "application/pdf", disposition: "attachment" });
    expect(Buffer.from(email.attachments[0]?.content as ArrayBuffer).equals(Buffer.from(PDF_BYTES))).toBe(true);
  });

  it("carries the mail and world headers, the Argentine date and no other recipient header", () => {
    const headers = headerBlock(buildMime(input()).raw);
    expect(headers).toContain(`X-Reclamo-Mail-Id: ${TEST_MAIL_ID}`);
    expect(headers).toContain("X-Reclamo-World: g01");
    expect(headers).toContain("Date: Wed, 07 Oct 2026 10:10:00 -0300");
    expect(headers).toContain("Auto-Submitted: auto-generated");
    expect(headers).not.toMatch(/^(Cc|Bcc|Reply-To|Message-ID|Sender):/im);
    expect(headers.match(/^To:/gim)).toHaveLength(1);
    // Non-ASCII header text goes RFC 2047-encoded: nothing outside printable ASCII on the wire.
    expect(headers).toMatch(/^[\x20-\x7e\r\n]*$/);
  });

  it("formats the Date header in Argentina's offset", () => {
    expect(rfc5322Date(new Date("2026-10-22T02:59:59Z"))).toBe("Wed, 21 Oct 2026 23:59:59 -0300");
  });

  it("keeps the email without attachments a multipart with both alternatives", async () => {
    const summary = await inspectMime(buildMime(input({ attachments: [] })).raw);
    expect(summary.attachments).toEqual([]);
    expect(summary.text).toContain("R-2026-000123");
    expect(summary.html).toContain("<p>");
  });

  it.each([
    ["a part that is not a PDF", { attachments: [{ filename: "acuse.pdf", bytes: new TextEncoder().encode("MZ not a pdf") }] }],
    ["a filename with a path", { attachments: [{ filename: "../acuse.pdf", bytes: PDF_BYTES }] }],
    ["six attachments", { attachments: Array.from({ length: 6 }, (_, n) => ({ filename: `doc-${n}.pdf`, bytes: PDF_BYTES })) }],
    ["more than 2 MB in total", { attachments: [{ filename: "big.pdf", bytes: new Uint8Array([...PDF_BYTES, ...new Uint8Array(MAX_ATTACHMENTS_BYTES)]) }] }],
    ["a subject with a line break", { subject: "Reclamo R-2026-000123\r\nBcc: someone@simulator.amazonses.com" }],
    ["a recipient with a display name", { to: "Ana <success@simulator.amazonses.com>" }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => buildMime(input(overrides as Partial<MimeInput>))).toThrow(expect.objectContaining({ code: "INVALID" }));
  });
});

describe("single recipient between the MIME and Destination [FL-073]", () => {
  it("accepts the built MIME with Destination equal to its To", async () => {
    const summary = await inspectMime(buildMime(input()).raw);
    expect(() => assertSingleRecipient(["success+g01-cus-0001@simulator.amazonses.com"], summary)).not.toThrow();
  });

  it("refuses a MIME with a Cc or a Bcc, a second To, or a Destination that is not its To", async () => {
    const raw = (extra: string) =>
      new TextEncoder().encode(`From: <${ANSWERS_ADDRESS}>\r\nTo: <success@simulator.amazonses.com>\r\n${extra}Subject: x\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nx\r\n`);
    const destination = ["success@simulator.amazonses.com"];
    expect(() => assertSingleRecipient(destination, { to: destination, cc: 0, bcc: 0 })).not.toThrow();
    await expect(inspectMime(raw("Cc: <bounce@simulator.amazonses.com>\r\n")).then((summary) => assertSingleRecipient(destination, summary))).rejects.toMatchObject({ code: "INVALID" });
    await expect(inspectMime(raw("Bcc: <complaint@simulator.amazonses.com>\r\n")).then((summary) => assertSingleRecipient(destination, summary))).rejects.toMatchObject({ code: "INVALID" });
    await expect(inspectMime(raw("To: <ooto@simulator.amazonses.com>\r\n")).then((summary) => assertSingleRecipient(destination, summary))).rejects.toMatchObject({ code: "INVALID" });
    const summary = await inspectMime(buildMime(input()).raw);
    expect(() => assertSingleRecipient(["bounce+g01-cus-0001@simulator.amazonses.com"], summary)).toThrow(expect.objectContaining({ code: "INVALID" }));
    expect(() => assertSingleRecipient([], summary)).toThrow(expect.objectContaining({ code: "INVALID" }));
  });
});

describe("text and HTML parts of a customer email [FL-011]", () => {
  it("escapes what was drafted, keeps paragraphs and ends with the fixed footer", () => {
    const content = renderEmailContent({ greeting: "Hola Ana:", paragraphs: ["Tu pago <b>figura</b> & quedó imputado.\n\nSaludos."], complaintNumber: "R-2026-000123", bcraFooter: true });
    expect(content.html).toContain("<p style=\"margin:0 0 16px\">Tu pago &lt;b&gt;figura&lt;/b&gt; &amp; quedó imputado.</p>");
    expect(content.html).not.toMatch(/<(script|img|a|link|iframe)\b/i);
    expect(content.text).toContain("Tu pago <b>figura</b> & quedó imputado.\n\nSaludos.");
    for (const fixed of [EMAIL_TEXT.NO_REPLY, "Reclamo R-2026-000123", EMAIL_TEXT.FOOTER_BCRA, EMAIL_TEXT.FOOTER_SYNTHETIC]) {
      expect(content.text).toContain(fixed);
      expect(content.html).toContain(fixed);
    }
  });

  it("leaves the BCRA line out when the email is not a written answer", () => {
    const content = renderEmailContent({ paragraphs: ["Registramos tu reclamo."], bcraFooter: false });
    expect(content.text).not.toContain(EMAIL_TEXT.FOOTER_BCRA);
    expect(content.text).toContain(EMAIL_TEXT.FOOTER_SYNTHETIC);
  });

  it("puts every world's objects under its root", () => {
    expect(worldObjectRoot("demo")).toBe("W/demo/");
    expect(worldObjectRoot("gs-abcdefghij")).toBe("W/gs-abcdefghij/");
    expect(worldObjectRoot("qa-123456789-1-sc01")).toBe("qa/123456789-1/qa-123456789-1-sc01/");
    expect(worldObjectRoot("qamin")).toBe("qa/qamin/");
  });
});
