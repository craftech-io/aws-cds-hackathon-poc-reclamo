// Conversations and compliance tape of a template (docs/seed-spec.md §10): the last week of each
// persona with 0 to 4 previous messages (every window closed at the start; C01 has none), every
// outbound with its `ALLOWED` and `DISPATCH` entries, and six historical blocks so the tape view never
// starts empty. Texts come from copy/ (persona scripts and WhatsApp texts); nothing is written here.
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import { AUTOMATED_DISCLOSURE, ChannelRuleId, WHATSAPP_TEXT } from "@reclamo/bff/copy/index";
import { chain } from "../lib/chain";
import { EPOCH_PLACEHOLDER, START_DATE, TEST_CUSTOMER_REF_KEY, WORLD_PLACEHOLDER } from "../lib/constants";
import { hmacHex, sha256Hex } from "../lib/json";
import { addMinutes, businessDaysBefore, localInstant, utcOf } from "./calendar";
import type { Json } from "./history";
import type { Rng } from "./rng";

export const RULE_SET_VERSION = "v001";

/** Inbound questions the personas asked last week (consultas of the persona scripts). */
const INBOUND_POOL = PERSONA_SCRIPTS.flatMap((script) => script.messages.filter((message) => message.intake.kind === "CONSULTA").map((message) => message.text));

/** What the agent answered: asked for the identity challenge, then said it was looking into it. */
const REPLIES = [WHATSAPP_TEXT.CHALLENGE_LAST_DUE_DATE, WHATSAPP_TEXT.HOLDING_NOTICE_NO_COMPLAINT];

export function customerRef(customerId: string): string {
  return hmacHex(TEST_CUSTOMER_REF_KEY, customerId);
}

/** Every rule the policy evaluates, with its result, in the policy's order. */
export function evaluated(results: Partial<Record<string, string>> = {}): Json[] {
  return ChannelRuleId.options.map((ruleId) => ({ ruleId, result: results[ruleId] ?? "PASS" }));
}

interface TapeDraft {
  readonly atSim: string;
  readonly entry: Json;
}

export interface ConversationBundle {
  readonly metas: Json[];
  readonly messages: Json[];
  readonly tape: Json[];
}

function tapeBase(atSim: string, tapeId: string): Json {
  return { worldId: WORLD_PLACEHOLDER, epoch: EPOCH_PLACEHOLDER, atSim, atReal: utcOf(atSim), tapeId, ruleSetVersion: RULE_SET_VERSION, synthetic: true };
}

/** Historical blocks: two collection attempts of an operator, two out of the window, one deferred, one credit offer. */
function historicalBlocks(customers: readonly string[]): TapeDraft[] {
  const pick = (index: number): string => customers[index % customers.length] ?? "cus-1001";
  const rows: Array<{ at: string; rule: string; decision: string; sender: string; channel: string; kind: string; payload: string; customer: string; extra?: Json }> = [
    { at: localInstant("2026-09-14", "11:20"), rule: "CH-WA-NO-COLLECTION", decision: "BLOCKED", sender: "OPERATOR:stf-operator-01", channel: "WHATSAPP", kind: "COLLECTION_REMINDER", payload: "history-block-1", customer: pick(3) },
    { at: localInstant("2026-09-24", "16:05"), rule: "CH-WA-NO-COLLECTION", decision: "BLOCKED", sender: "OPERATOR:stf-operator-01", channel: "WHATSAPP", kind: "OPERATOR_MESSAGE", payload: "history-block-2", customer: pick(11) },
    { at: localInstant("2026-08-27", "10:40"), rule: "CH-WA-24H", decision: "BLOCKED", sender: "AGENT", channel: "WHATSAPP", kind: "COMPLAINT_UPDATE", payload: "history-block-3", customer: pick(19) },
    { at: localInstant("2026-09-17", "15:10"), rule: "CH-WA-24H", decision: "BLOCKED", sender: "AGENT", channel: "WHATSAPP", kind: "COMPLAINT_UPDATE", payload: "history-block-4", customer: pick(23) },
    { at: localInstant("2026-09-19", "19:30"), rule: "CH-CONTACT-HOURS", decision: "DEFERRED", sender: "SYSTEM", channel: "EMAIL", kind: "COMPLAINT_UPDATE", payload: "history-block-5", customer: pick(29), extra: { nextAllowedAt: localInstant("2026-09-21", "08:00") } },
    { at: localInstant("2026-09-30", "12:15"), rule: "CH-NO-CREDIT-OFFER", decision: "BLOCKED", sender: "OPERATOR:stf-operator-01", channel: "EMAIL", kind: "OPERATOR_MESSAGE", payload: "history-block-6", customer: pick(31) },
  ];
  const drafts: TapeDraft[] = [];
  rows.forEach((row, index) => {
    const tapeId = `tp-blk-${index + 1}`;
    const messageId = `msg-blk-${index + 1}`;
    drafts.push({
      atSim: row.at,
      entry: {
        ...tapeBase(row.at, tapeId),
        decision: row.decision,
        ruleIds: [row.rule],
        evaluated: evaluated({ [row.rule]: row.decision }),
        sender: row.sender,
        channel: row.channel,
        kind: row.kind,
        payloadHash: sha256Hex(row.payload),
        messageId,
        customerRef: customerRef(row.customer),
        ...(row.rule === "CH-WA-NO-COLLECTION" ? { reroute: { route: "HUMAN_QUEUE" } } : {}),
        ...(row.extra ?? {}),
      },
    });
    if (row.decision === "DEFERRED" && typeof row.extra?.nextAllowedAt === "string") {
      const at = row.extra.nextAllowedAt;
      const common = { sender: row.sender, channel: row.channel, kind: row.kind, payloadHash: sha256Hex(row.payload), messageId, customerRef: customerRef(row.customer) };
      drafts.push({ atSim: at, entry: { ...tapeBase(at, `${tapeId}-a`), decision: "ALLOWED", ruleIds: [], evaluated: evaluated(), ...common } });
      const sent = addMinutes(at, 1);
      drafts.push({ atSim: sent, entry: { ...tapeBase(sent, `${tapeId}-d`), decision: "DISPATCH", result: "SENT", ruleIds: [], evaluated: [], providerMessageId: `ses-${messageId}`, ...common } });
    }
  });
  return drafts;
}

/** Persona customer ids that get previous messages, and how many exchanges. */
function exchangesOf(number: number): number {
  if (number === 1) return 0;
  if (number % 9 === 0) return 2;
  return number % 3 === 0 ? 1 : 0;
}

export function buildConversations(personaCustomers: readonly string[], openByCustomer: ReadonlyMap<string, string[]>, blockCustomers: readonly string[], rng: Rng): ConversationBundle {
  const metas: Json[] = [];
  const messages: Json[] = [];
  const drafts: TapeDraft[] = historicalBlocks(blockCustomers);
  const lastWeek = businessDaysBefore(START_DATE, 5).slice(0, 4);
  const conversationCustomers = [...new Set([...personaCustomers, ...openByCustomer.keys()])].sort();
  for (const customerId of conversationCustomers) {
    const number = Number(customerId.slice(4));
    const exchanges = personaCustomers.includes(customerId) ? exchangesOf(number) : 0;
    let lastInbound: string | undefined;
    for (let exchange = 0; exchange < exchanges; exchange += 1) {
      const date = lastWeek[(number + exchange) % lastWeek.length] ?? lastWeek[0] ?? "2026-09-30";
      const inboundAt = localInstant(date, `${String(10 + exchange * 3 + rng.int(0, 2)).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}`);
      const outboundAt = addMinutes(inboundAt, 1);
      const inId = `msg-${customerId.slice(4)}-h${exchange * 2 + 1}`;
      const outId = `msg-${customerId.slice(4)}-h${exchange * 2 + 2}`;
      const tapeId = `tp-${customerId.slice(4)}-h${exchange + 1}`;
      const text = REPLIES[exchange] ?? WHATSAPP_TEXT.HOLDING_NOTICE_NO_COMPLAINT;
      const body = exchange === 0 ? `${AUTOMATED_DISCLOSURE}\n\n${text}` : text;
      const common = { worldId: WORLD_PLACEHOLDER, customerId, channel: "WHATSAPP", simulated: true, version: 1, synthetic: true };
      messages.push({ ...common, messageId: inId, direction: "IN", body: rng.pick(INBOUND_POOL), status: "READ", atSim: inboundAt, flags: {}, turnId: `turn-${inId.slice(4)}` });
      messages.push({ ...common, messageId: outId, direction: "OUT", kind: "REPLY", sender: "AGENT", body, status: "READ", tapeRef: tapeId, turnId: `turn-${inId.slice(4)}`, flags: { disclosure: exchange === 0 }, atSim: outboundAt, sentAtSim: outboundAt, providerMessageId: `sim-${outId}` });
      const tapeCommon = { sender: "AGENT", channel: "WHATSAPP", kind: "REPLY", payloadHash: sha256Hex(body), messageId: outId, customerRef: customerRef(customerId) };
      drafts.push({ atSim: outboundAt, entry: { ...tapeBase(outboundAt, tapeId), decision: "ALLOWED", ruleIds: [], evaluated: evaluated(), ...tapeCommon } });
      const dispatched = addMinutes(outboundAt, 1);
      drafts.push({ atSim: dispatched, entry: { ...tapeBase(dispatched, `${tapeId}-d`), decision: "DISPATCH", result: "SENT", ruleIds: [], evaluated: [], providerMessageId: `sim-${outId}`, ...tapeCommon } });
      lastInbound = inboundAt;
    }
    metas.push({
      worldId: WORLD_PLACEHOLDER,
      customerId,
      control: "AGENT",
      controlHistory: [],
      ...(lastInbound ? { lastInboundAtSim: lastInbound, windowOpenUntilSim: addMinutes(lastInbound, 24 * 60) } : {}),
      sessionEpoch: 0,
      disclosedEpochs: exchanges > 0 ? [0] : [],
      openComplaintIds: openByCustomer.get(customerId) ?? [],
      version: 1,
      synthetic: true,
    });
  }
  const tape = chain(drafts.sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim) || (String(a.entry.tapeId) < String(b.entry.tapeId) ? -1 : 1)).map((draft) => draft.entry));
  return { metas, messages, tape };
}
