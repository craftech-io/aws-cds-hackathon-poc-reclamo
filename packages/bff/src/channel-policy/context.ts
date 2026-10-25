// What every rule reads, computed once per evaluation: the parsed input, the instant in simulated and
// real time, the sender class, the time base of the WhatsApp window, the history without the decided
// message itself and whether the send is a reply to the customer (window.ts).
import type { ChannelMode } from "@reclamo/shared";
import { type SenderClass, senderClassOf } from "./kinds";
import type { EvaluationMode, HistoryMessage, ParsedPolicyInput } from "./types";
import { replyOf } from "./window";

/** The 24-hour window runs on real time when WhatsApp is live (Meta measures it) and on the world's clock otherwise. */
export type TimeBase = "SIM" | "REAL";

export interface PolicyContext {
  readonly mode: EvaluationMode;
  readonly input: ParsedPolicyInput;
  readonly request: ParsedPolicyInput["request"];
  readonly settings: ParsedPolicyInput["settings"];
  readonly simNow: Date;
  readonly realNow: Date;
  readonly senderClass: SenderClass;
  readonly byWhatsApp: boolean;
  readonly windowBase: TimeBase;
  /** The customer's messages, without the decided message itself; `undefined` when none were given. */
  readonly history: readonly HistoryMessage[] | undefined;
  /** `undefined` when there is no history to prove it either way. */
  readonly reply: boolean | undefined;
}

export type WindowView = Omit<PolicyContext, "reply">;

function timeBaseOf(mode: ChannelMode): TimeBase {
  return mode === "live" ? "REAL" : "SIM";
}

export function buildContext(input: ParsedPolicyInput, mode: EvaluationMode): PolicyContext {
  const { request } = input;
  const view: WindowView = {
    mode,
    input,
    request,
    settings: input.settings,
    simNow: input.clock.simNow,
    realNow: input.clock.realNow,
    senderClass: senderClassOf(request.sender),
    byWhatsApp: request.channel === "WHATSAPP",
    windowBase: timeBaseOf(input.modes.whatsapp),
    history: input.history?.filter((entry) => entry.messageId !== request.messageId),
  };
  return { ...view, reply: replyOf(view) };
}
