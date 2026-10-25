// The user message of a turn (docs/design-brief.md §8.2): an envelope written by code, never free text
// from the edge.
//
//   <session token="…"/>                                          signed session token of the turn
//   <event type="CUSTOMER_MESSAGE" id="evt_…" at="…-03:00"/>
//   <facts>…</facts>                                              one fact per line, every value escaped
//   <inbound-5c1e9a0b1d2e channel="WHATSAPP" from-role="CUSTOMER" truncated="false">
//     …normalized, masked text with &lt; &gt; &amp; escaped…
//   </inbound-5c1e9a0b1d2e>
//   <memory-5c1e9a0b1d2e>…validated preferences, facts and summary, escaped…</memory-5c1e9a0b1d2e>
//   <attachment evidenceId="ev_…" kind="RECEIPT_IMAGE" status="PENDING_READ"/>
//   <tool-result tool="identify_customer">{…}</tool-result>      reads the worker already ran (ADR-0021 §7)
//
// Every value that is not a fixed word of this module is escaped, and the untrusted text and the memory
// sit inside the turn's random delimiters, so a customer (or a memory record) can never close a block
// and forge an `<event>`, `<facts>`, `<session>` or `<tool-result>`. File names, image pixels and
// metadata never reach this module. Pure on purpose: turns/facts.ts gathers the inputs.
import { type Channel, type TurnTrigger, TurnTrigger as TurnTriggerSchema } from "@reclamo/shared";
import { TURN_DELIMITER_PATTERN, escapeUntrusted, untrustedBlock } from "../channels/normalizer";
import { memoryTagOf } from "./system-prompt";

/** `<worldId>.<sessionId>.<turnId>.<exp>.<HMAC>` (services/session.ts). */
export const SESSION_TOKEN_PATTERN = /^[a-z0-9-]{1,48}\.[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{8,64}\.\d{10}\.[A-Za-z0-9_-]{43}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:+=@-]{0,127}$/;

export interface EnvelopeEvent {
  readonly type: TurnTrigger;
  readonly id: string;
  /** Simulated instant of the event, ISO 8601 with the Argentine offset. */
  readonly at: string;
}

export type FactValue = string | number | boolean;

/** One line of `<facts>`: a name and its attributes, all rendered escaped. */
export interface FactLine {
  readonly name: string;
  readonly attributes: Readonly<Record<string, FactValue>>;
}

/** Who wrote the inbound text: the customer, or the operator whose messages a release summarizes. */
export type InboundRole = "CUSTOMER" | "OPERATOR";

export interface InboundBlock {
  /** `inbound-<12 hex>`, the same the turn's system prompt names. */
  readonly delimiter: string;
  /** Already normalized and masked (channels/normalizer.ts, and G1 when it anonymized). */
  readonly text: string;
  readonly channel: Channel | "CONSOLE";
  readonly fromRole: InboundRole;
  readonly truncated: boolean;
}

export interface AttachmentLine {
  readonly evidenceId: string;
  readonly kind: "RECEIPT_IMAGE";
  /** `PENDING_READ` until `read_receipt` left its reading. */
  readonly status: "PENDING_READ" | "READ";
}

/** A read tool the worker ran with the turn's token before the Harness: the tool's own answer. */
export interface PreloadedResult {
  readonly tool: string;
  readonly output: unknown;
}

export interface EnvelopeInput {
  readonly sessionToken: string;
  readonly event: EnvelopeEvent;
  readonly facts: readonly FactLine[];
  /** The delimiter of the turn: names the inbound and the memory block. */
  readonly delimiter: string;
  readonly inbound?: Omit<InboundBlock, "delimiter">;
  /** Validated memory lines (agent/memory.ts), rendered inside `<memory-…>` as data. */
  readonly memory?: readonly string[];
  readonly attachments?: readonly AttachmentLine[];
  readonly preloaded?: readonly PreloadedResult[];
}

/** At most this many attachment lines and memory lines. */
export const MAX_ENVELOPE_ATTACHMENTS = 10;
export const MAX_MEMORY_LINES = 13;

const FACT_NAME = /^[a-z][a-zA-Z0-9-]{0,31}$/;
const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z_]{0,40}$/;

function attributes(values: Readonly<Record<string, FactValue>>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      if (!ATTRIBUTE_NAME.test(name)) throw new RangeError(`invalid envelope attribute "${name}"`);
      return ` ${name}="${escapeUntrusted(String(value))}"`;
    })
    .join("");
}

function sessionLine(token: string): string {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new RangeError("the envelope needs a well-formed session token");
  return `<session token="${token}"/>`;
}

function eventLine(event: EnvelopeEvent): string {
  TurnTriggerSchema.parse(event.type);
  if (!EVENT_ID.test(event.id)) throw new RangeError("the envelope event needs an event id");
  if (Number.isNaN(Date.parse(event.at))) throw new RangeError("the envelope event needs an instant");
  return `<event${attributes({ type: event.type, id: event.id, at: event.at })}/>`;
}

function factsBlock(facts: readonly FactLine[]): string {
  const lines = facts.map((fact) => {
    if (!FACT_NAME.test(fact.name)) throw new RangeError(`invalid fact name "${fact.name}"`);
    return `${fact.name}${attributes(fact.attributes)}`;
  });
  return ["<facts>", ...lines, "</facts>"].join("\n");
}

function inboundBlock(delimiter: string, inbound: Omit<InboundBlock, "delimiter">): string {
  return untrustedBlock(delimiter, inbound.text, { channel: inbound.channel, "from-role": inbound.fromRole, truncated: inbound.truncated });
}

function memoryBlock(delimiter: string, lines: readonly string[]): string {
  const tag = memoryTagOf(delimiter);
  return `<${tag}>\n${lines.slice(0, MAX_MEMORY_LINES).map(escapeUntrusted).join("\n")}\n</${tag}>`;
}

function attachmentLine(attachment: AttachmentLine): string {
  if (!EVENT_ID.test(attachment.evidenceId)) throw new RangeError("invalid evidence id");
  return `<attachment${attributes({ evidenceId: attachment.evidenceId, kind: attachment.kind, status: attachment.status })}/>`;
}

/**
 * The tool's JSON with `<`, `>` and `&` as JSON escapes: still the same JSON to read, and no value the
 * tool returned (a description from the core, a name) can close the element or open another one.
 */
export function preloadedLine(result: PreloadedResult): string {
  if (!TOOL_NAME.test(result.tool)) throw new RangeError(`invalid preloaded tool "${result.tool}"`);
  const json = JSON.stringify(result.output).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<tool-result tool="${result.tool}">${json}</tool-result>`;
}

/** The envelope text of a turn. Throws on a malformed fixed part: a bug, never a message. */
export function renderEnvelope(input: EnvelopeInput): string {
  if (!TURN_DELIMITER_PATTERN.test(input.delimiter)) throw new RangeError("not a turn delimiter");
  const attachments = input.attachments ?? [];
  if (attachments.length > MAX_ENVELOPE_ATTACHMENTS) throw new RangeError(`at most ${MAX_ENVELOPE_ATTACHMENTS} attachment lines`);
  const memory = input.memory ?? [];
  return [
    sessionLine(input.sessionToken),
    eventLine(input.event),
    factsBlock(input.facts),
    ...(input.inbound === undefined ? [] : [inboundBlock(input.delimiter, input.inbound)]),
    ...(memory.length === 0 ? [] : [memoryBlock(input.delimiter, memory)]),
    ...attachments.map(attachmentLine),
    ...(input.preloaded ?? []).map(preloadedLine),
  ].join("\n");
}
