// The identity challenge as the local flows play it (docs/flows-catalog.md FL-003): the agent asks it
// with the `promptText` the worker preloaded, the persona answers on their phone in a later message, and
// only that turn verifies, passing what the customer wrote (the envelope's inbound text). A flow never
// verifies on a turn whose customer did not write the answer: `verify_challenge` refuses it.
import { localDateAr } from "@reclamo/bff/services/business-days";
import type { InboundSummary } from "@reclamo/bff/channels/whatsapp/inbound";
import type { PlannedCall, ScriptedTurn } from "./scripted-harness";
import type { FlowWorld } from "./world";

interface PreloadedIdentity {
  readonly status?: string;
  readonly challenge?: { readonly kind?: string; readonly promptText?: string };
}

const preloadedIdentity = (turn: ScriptedTurn): PreloadedIdentity | undefined => turn.preloaded.identify_customer as PreloadedIdentity | undefined;

/** The worker's preloaded `identify_customer` says the session is not identified yet. */
export function needsChallenge(turn: ScriptedTurn): boolean {
  return preloadedIdentity(turn)?.status === "NEEDS_CHALLENGE";
}

/** What `answerChallenge` writes: a `d/m` date or an amount in pesos, nothing else. */
const ANSWER_SHAPE = /^(?:\d{1,2}\/\d{1,2}|\d+(?:\.\d{1,2})?)$/;

/** The customer's message of this turn answers the challenge (the session is still not identified). */
export function repliesToChallenge(turn: ScriptedTurn): boolean {
  return needsChallenge(turn) && ANSWER_SHAPE.test(turn.inbound ?? "");
}

/** The agent asks the challenge with its fixed text, as the system prompt says. */
export const askChallenge: PlannedCall = {
  tool: "send_whatsapp",
  input: (_earlier, turn) => ({ kind: "IDENTITY_CHALLENGE", text: preloadedIdentity(turn)?.challenge?.promptText ?? "" }),
};

/** The agent checks what the customer wrote in this turn, exactly as written. */
export const verifyWritten: PlannedCall = { tool: "verify_challenge", input: (_earlier, turn) => ({ answer: turn.inbound ?? "" }) };

/** The persona's right answer to `kind`, from the core rows of its world at the world's today. */
export async function challengeAnswer(world: FlowWorld, customerId: string, kind = "LAST_DUE_DATE", worldId: string = world.worldId): Promise<string> {
  const now = await world.simNow(worldId);
  const today = localDateAr(now);
  const rows = world.mocks.coreStore.dump().filter((item) => item.pk === `W#${worldId}#CUS#${customerId}`);
  if (kind === "LAST_MOVEMENT_AMOUNT") {
    const movements = rows.filter((item) => item.entity === "Movement" && Date.parse(String(item.atSim)) <= now.getTime());
    const last = movements.sort((a, b) => Date.parse(String(a.atSim)) - Date.parse(String(b.atSim))).at(-1);
    if (last === undefined) throw new Error(`${customerId} has no wallet movement`);
    return String(Number(last.amount) / 100);
  }
  const last = rows
    .filter((item) => item.entity === "Instalment" && String(item.dueDate) <= today)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .at(-1);
  if (last === undefined) throw new Error(`${customerId} has no instalment due`);
  if (kind === "LAST_INSTALMENT_AMOUNT") return String(Number(last.amount) / 100);
  const [, month, day] = String(last.dueDate).split("-");
  return `${Number(day)}/${Number(month)}`;
}

/** The kind of the last challenge the agent asked the customer, from its text. */
async function askedKind(world: FlowWorld, customerId: string, worldId: string): Promise<string> {
  const asked = (await world.connector.conversations.listMessages(worldId, customerId)).filter((message) => message.kind === "IDENTITY_CHALLENGE").at(-1);
  if (asked === undefined) throw new Error(`the agent never asked ${customerId} the identity challenge`);
  const text = asked.body.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return /movimiento/.test(text) ? "LAST_MOVEMENT_AMOUNT" : /importe/.test(text) ? "LAST_INSTALMENT_AMOUNT" : "LAST_DUE_DATE";
}

/** The persona answers, on their phone, the challenge the agent asked them (right, or `answer`). */
export async function answerChallenge(world: FlowWorld, customerId: string, options: { readonly answer?: string; readonly worldId?: string } = {}): Promise<InboundSummary> {
  const worldId = options.worldId ?? world.worldId;
  const text = options.answer ?? (await challengeAnswer(world, customerId, await askedKind(world, customerId, worldId), worldId));
  return world.phone(customerId, { type: "text", text }, { worldId });
}
