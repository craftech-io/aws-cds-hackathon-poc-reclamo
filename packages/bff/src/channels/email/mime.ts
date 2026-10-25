// The raw MIME of every customer email (docs/architecture-integrations.md §1): built here and sent
// with `Content.Raw`, so the `.eml` stored in `Emails` is exactly what left. Deterministic: the same
// input gives the same bytes (boundaries derive from the `mailId`, the `Date` is the world's simulated
// instant, no random part), which is what lets the viewer and QA compare SHA-256s.
//
//   multipart/mixed
//   ├── multipart/alternative
//   │   ├── text/plain; charset=utf-8   (base64)
//   │   └── text/html; charset=utf-8    (base64)
//   └── application/pdf …               (base64, attachment; at most five, 2 MB in total)
//
// One `To`, never `Cc` nor `Bcc`, no `Reply-To` (there is no inbound email, ADR-0003) and no
// `Message-ID` (SES writes it and its id becomes `providerMessageId`). `inspectMime` re-reads the
// bytes with postal-mime so the client can check them before SES sees them.
import PostalMime, { type Address, addressParser } from "postal-mime";
import { ChannelError } from "@reclamo/shared";
import { sha256Hex } from "../../lib/crypto";
import { assertHeaderValue, encodeHeaderText, formatMailbox, parseAddress } from "./address";
import { ATTACHMENT_FILENAME, MAIL_ID_HEADER, MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, PDF_CONTENT_TYPE, WORLD_HEADER } from "./config";

export interface MimeAttachment {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface MimeInput {
  readonly from: { readonly displayName: string; readonly address: string };
  /** The fenced recipient (recipient-fence.ts); the only address of the message. */
  readonly to: string;
  readonly subject: string;
  /** The world's simulated instant of the send. */
  readonly date: Date;
  readonly mailId: string;
  readonly worldId: string;
  readonly text: string;
  readonly html: string;
  readonly attachments: readonly MimeAttachment[];
}

export interface BuiltMime {
  readonly raw: Uint8Array;
  /** SHA-256 of `raw`: what the viewer shows next to the `.eml`. */
  readonly sha256: string;
}

const CRLF = "\r\n";
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Argentina keeps UTC−3 all year: every `Date` header is written in that offset. */
const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

export function startsWithPdfMagic(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** RFC 5322 date in Argentina's offset: `Wed, 07 Oct 2026 10:10:00 -0300`. */
export function rfc5322Date(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new ChannelError("INVALID", "EMAIL", "invalid email date");
  const local = new Date(date.getTime() + AR_OFFSET_MS);
  const day = `${WEEKDAYS[local.getUTCDay()]}, ${two(local.getUTCDate())} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}`;
  return `${day} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())} -0300`;
}

/** Base64 in lines of 76 characters (RFC 2045 §6.8). */
function base64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
  return lines.join(CRLF);
}

function utf8Crlf(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r\n|\r|\n/g, CRLF));
}

function boundaryOf(mailId: string, part: "mixed" | "alt"): string {
  // `_` never appears in base64, so the boundary cannot occur inside an encoded body.
  return `=_${part}_${sha256Hex(`${mailId}:${part}`).slice(0, 24)}`;
}

function checkAttachments(attachments: readonly MimeAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS) throw new ChannelError("INVALID", "EMAIL", `at most ${MAX_ATTACHMENTS} attachments`);
  const total = attachments.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > MAX_ATTACHMENTS_BYTES) throw new ChannelError("INVALID", "EMAIL", `attachments exceed ${MAX_ATTACHMENTS_BYTES} bytes`);
  for (const file of attachments) {
    if (!ATTACHMENT_FILENAME.test(file.filename)) throw new ChannelError("INVALID", "EMAIL", "invalid attachment filename");
    if (!startsWithPdfMagic(file.bytes)) throw new ChannelError("INVALID", "EMAIL", "an attachment is not a PDF");
  }
}

function part(headers: readonly string[], body: string): string {
  return [...headers, "", body].join(CRLF);
}

export function buildMime(input: MimeInput): BuiltMime {
  const to = parseAddress(input.to);
  const from = parseAddress(input.from.address);
  if (!to.ok || !from.ok) throw new ChannelError("INVALID", "EMAIL", "invalid From or To address");
  checkAttachments(input.attachments);
  const subject = assertHeaderValue("Subject", input.subject);
  const mixed = boundaryOf(input.mailId, "mixed");
  const alt = boundaryOf(input.mailId, "alt");

  const alternative = [
    `--${alt}`,
    part(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"], base64Lines(utf8Crlf(input.text))),
    `--${alt}`,
    part(["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64"], base64Lines(utf8Crlf(input.html))),
    `--${alt}--`,
  ].join(CRLF);

  const files = input.attachments.flatMap((file) => [
    `--${mixed}`,
    part([`Content-Type: ${PDF_CONTENT_TYPE}; name="${file.filename}"`, `Content-Disposition: attachment; filename="${file.filename}"`, "Content-Transfer-Encoding: base64"], base64Lines(file.bytes)),
  ]);

  const headers = [
    `From: ${formatMailbox(input.from.displayName, from.value)}`,
    `To: <${to.value.address}>`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${rfc5322Date(input.date)}`,
    "MIME-Version: 1.0",
    "Content-Language: es-AR",
    "Auto-Submitted: auto-generated",
    `${MAIL_ID_HEADER}: ${assertHeaderValue(MAIL_ID_HEADER, input.mailId)}`,
    `${WORLD_HEADER}: ${assertHeaderValue(WORLD_HEADER, input.worldId)}`,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];

  const body = [`--${mixed}`, part([`Content-Type: multipart/alternative; boundary="${alt}"`], alternative), ...files, `--${mixed}--`, ""].join(CRLF);
  const raw = new TextEncoder().encode([...headers, "", body].join(CRLF));
  return { raw, sha256: sha256Hex(raw) };
}

// ---- Reading a built MIME back -------------------------------------------------------------------

export interface MimeSummary {
  /** Addresses of every mailbox of every `To` header (groups flattened), lower case. */
  readonly to: readonly string[];
  /** `Cc` and `Bcc` headers and mailboxes found: anything above zero refuses the send. */
  readonly cc: number;
  readonly bcc: number;
  readonly subject: string;
  readonly mailId: string | undefined;
  readonly worldId: string | undefined;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: readonly { readonly filename: string | null; readonly contentType: string; readonly bytes: Uint8Array }[];
}

function mailboxes(addresses: readonly Address[] | undefined): string[] {
  return (addresses ?? []).flatMap((entry) => (entry.group === undefined ? [entry.address] : entry.group.map((member) => member.address))).map((address) => address.toLowerCase());
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export async function inspectMime(raw: Uint8Array): Promise<MimeSummary> {
  let email;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", maxNestingDepth: 8 });
  } catch (error) {
    throw new ChannelError("PARSE_FAILED", "EMAIL", "the built MIME does not parse", { cause: error });
  }
  const header = (name: string) => email.headers.filter((entry) => entry.key === name);
  return {
    to: header("to").flatMap((entry) => mailboxes(addressParser(entry.value))),
    cc: mailboxes(email.cc).length + header("cc").length,
    bcc: mailboxes(email.bcc).length + header("bcc").length,
    subject: email.subject ?? "",
    mailId: header(MAIL_ID_HEADER.toLowerCase())[0]?.value,
    worldId: header(WORLD_HEADER.toLowerCase())[0]?.value,
    text: email.text,
    html: email.html,
    attachments: email.attachments.map((file) => ({ filename: file.filename, contentType: file.mimeType.toLowerCase(), bytes: bytesOf(file.content) })),
  };
}
