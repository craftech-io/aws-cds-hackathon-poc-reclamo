// The only logger of the Lambdas: one JSON line per event with a correlation id that is born at
// the inbound event and travels through the worker, the Harness turn, the tools and the outbound
// gate. Redaction is not optional (docs/architecture.md §12): the common masker of lib/mask.ts
// (E.164, emails, CUIT/CUIL, DNI, CBU/CVU, cards by Luhn, secrets next to "clave"/"PIN") runs on
// every string, amounts are masked, raw provider events, message bodies, receipt fields and tool
// results are dropped, and an address only ever appears as a hash.
import { randomUUID } from "node:crypto";
import { MASK_TOKEN, maskSensitive } from "./mask";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export interface Logger {
  readonly correlationId: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Same correlation id, extra bindings on every line (tool name, channel, turn id). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly correlationId?: string;
  readonly bindings?: LogFields;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DEPTH = 6;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;

export const MASK = {
  phone: MASK_TOKEN.TELEFONO,
  email: MASK_TOKEN.EMAIL,
  document: "[document]",
  amount: "[amount]",
  name: "[name]",
  omitted: "[omitted]",
  number: "[number]",
} as const;

// Keys whose value never reaches a log line, whatever it holds: raw provider payloads, message
// bodies (they may carry personal data before the masker runs) and full tool results.
const OMITTED_KEYS = new Set([
  "event", "rawevent", "records", "record", "payload", "toolresult", "toolresults", "output", "body", "text", "html", "mime", "eml",
  "message_body", "content", "attachments", "image", "receiptfields", "sessiontoken", "token", "authorization", "secret", "signature", "password",
]);
const ADDRESS_KEYS = new Set(["address", "to", "from", "recipient", "sender", "destination", "replyto", "cc", "bcc"]);
const PHONE_KEYS = new Set(["phone", "phonee164", "phonenumber", "msisdn"]);
const EMAIL_KEYS = new Set(["email", "emailaddress", "mailfrom"]);
// "name" is masked too: log a tool or resource under `tool`, `target` or `resource`, never `name`.
const NAME_KEYS = new Set(["name", "displayname", "firstname", "lastname", "fullname", "contactname"]);
const DOCUMENT_KEYS = new Set(["document", "documentnumber", "docnumber", "dni", "cuit", "cuil", "cbu", "cvu", "card", "pan"]);
const AMOUNT_KEY = /(amount|balance|total|paid|price|fee|debt|instalment|refund|saldo|monto|importe|cuota)/i;
// Large numbers that are not money: instants, durations, sizes and counters keep their value.
const SAFE_NUMBER_KEY = /(at|ms|seconds|bytes|exp|ttl|epoch|count|seq|version|status|statuscode|attempt|attempts|size|length|day|days|tokens)$/i;

// Money as written in Spanish texts ("$ 668.200,00", "$486.000").
const MONEY_TEXT_PATTERN = /\$\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?/g;
// Any free-standing run of 7+ digits: DNI, CUIT without dashes, a phone without "+", or an
// amount above six digits. Runs glued to letters, "-" or "_" are ids and hashes and stay.
const LONG_DIGITS_PATTERN = /(?<![\w-])\d{7,}(?![\w-])/g;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export function redactText(value: string): string {
  if (ISO_INSTANT_PATTERN.test(value)) return value;
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]` : value;
  return maskSensitive(clipped).replace(MONEY_TEXT_PATTERN, MASK.amount).replace(LONG_DIGITS_PATTERN, MASK.number);
}

function redactNumber(key: string, value: number): number | string {
  if (AMOUNT_KEY.test(key)) return MASK.amount;
  if (Math.abs(value) >= 1_000_000 && !SAFE_NUMBER_KEY.test(key)) return MASK.number;
  return value;
}

function redactError(error: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: redactText(error.message) };
  for (const key of ["code", "reason", "channel", "table", "retryable"] as const) {
    const extra: unknown = Reflect.get(error, key);
    if (extra !== undefined) out[key] = redactValue(key, extra, depth + 1);
  }
  if (error.stack) out.stack = redactText(error.stack);
  if (error.cause !== undefined) out.cause = redactValue("cause", error.cause, depth + 1);
  return out;
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  const lowered = key.toLowerCase();
  if (value === null || value === undefined) return value;
  if (OMITTED_KEYS.has(lowered)) return MASK.omitted;
  if (PHONE_KEYS.has(lowered)) return MASK.phone;
  if (EMAIL_KEYS.has(lowered)) return MASK.email;
  if (ADDRESS_KEYS.has(lowered)) return typeof value === "string" && value.includes("@") ? MASK.email : MASK.phone;
  if (NAME_KEYS.has(lowered) && typeof value === "string") return MASK.name;
  if (DOCUMENT_KEYS.has(lowered)) return MASK.document;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number") return Number.isFinite(value) ? redactNumber(key, value) : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return MASK.number;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error) return redactError(value, depth);
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return MASK.omitted;
  // A Money object is masked whole so neither the integer nor its text survives.
  if (AMOUNT_KEY.test(key) && typeof value === "object" && !Array.isArray(value)) return MASK.amount;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(key, item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`…[${value.length - MAX_ARRAY} more]`);
    return items;
  }
  if (value instanceof Map) return redactValue(key, Object.fromEntries(value), depth);
  if (value instanceof Set) return redactValue(key, [...value], depth);
  if (value instanceof Uint8Array) return MASK.omitted;
  return redactFields(Object.fromEntries(Object.entries(value)), depth + 1);
}

export function redactFields(fields: Readonly<Record<string, unknown>>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const redacted = redactValue(key, value, depth);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

export function newCorrelationId(): string {
  return randomUUID();
}

function defaultLevel(): LogLevel {
  // Stage flags are the only values read from the environment (CLAUDE.md).
  if (process.env.NODE_ENV === "test") return "warn";
  return "info";
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function safeStringify(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  });
}

const RESERVED = new Set(["level", "time", "message", "correlationId"]);

export function createLogger(options: LoggerOptions = {}): Logger {
  const correlationId = options.correlationId ?? newCorrelationId();
  const threshold = LEVEL_WEIGHT[options.level ?? defaultLevel()];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const bindings = redactFields(options.bindings ?? {});

  function write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const record: Record<string, unknown> = { level, time: now().toISOString(), correlationId, message: redactText(message) };
    for (const [key, value] of Object.entries({ ...bindings, ...redactFields(fields ?? {}) })) {
      record[RESERVED.has(key) ? `field_${key}` : key] = value;
    }
    let line: string;
    try {
      line = safeStringify(record);
    } catch (error) {
      line = JSON.stringify({ level: "error", time: now().toISOString(), correlationId, message: "log serialization failed", cause: error instanceof Error ? error.name : "unknown" });
    }
    sink(line);
  }

  return {
    correlationId,
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (extra) => createLogger({ ...options, correlationId, bindings: { ...(options.bindings ?? {}), ...extra } }),
  };
}

// Correlation id of an inbound event: reuse the one the caller sent (console → BFF → tool) when it
// looks like an id, otherwise mint one. Anything else would let a sender inject log content.
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function correlationIdFrom(candidate: unknown): string {
  return typeof candidate === "string" && CORRELATION_PATTERN.test(candidate) ? candidate : newCorrelationId();
}
