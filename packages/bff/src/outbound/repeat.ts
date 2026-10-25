// Step 0 of the gate (ADR-0021 §9, FL-106): a model that asks for the same WhatsApp twice in one turn
// gets the message already sent, as a redelivered event would (`replayOf`), and nothing goes out
// again. Same turn, WhatsApp, and the same text or the same template with the same parameters, against
// an outbound of that turn that went out (or may have). It runs before the policy: a replay evaluates
// nothing, writes no tape entry and calls no transport; the gate audits `OUTBOUND_REPLAYED` with the
// original `messageId`. A different text, another turn or another channel goes through the gate.
import { wentOut } from "../channel-policy/kinds";
import type { Message } from "../domain/conversation";
import { withoutDisclosure } from "./render/disclosure";
import type { OutboundRequest } from "./types";

type Comparable = Pick<OutboundRequest, "channel" | "turnId" | "text" | "template">;

/** The template as compared: its name and its parameters in order. */
function templateKey(name: string, params: readonly string[]): string {
  return JSON.stringify([name, params]);
}

/** The outbound of the same turn this request repeats, if any (the oldest one). */
export function repeatedInTurn(request: Comparable, history: readonly Message[]): Message | undefined {
  if (request.turnId === undefined || request.channel !== "WHATSAPP") return undefined;
  const wanted = request.template === undefined ? undefined : templateKey(request.template.name, request.template.params);
  if (wanted === undefined && (request.text === undefined || request.text.trim() === "")) return undefined;
  return history.find((message) => {
    if (message.direction !== "OUT" || message.channel !== "WHATSAPP" || message.turnId !== request.turnId || !wentOut(message)) return false;
    if (wanted !== undefined) return message.templateName !== undefined && templateKey(message.templateName, message.templateParams ?? []) === wanted;
    return message.templateName === undefined && withoutDisclosure(message) === request.text;
  });
}
