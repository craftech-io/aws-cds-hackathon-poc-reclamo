// `send_whatsapp` (docs/tool-catalog.md, target `messaging`): the only way the agent writes to the
// customer, always through the outbound gate. The wrapper already proved the session, the strict input
// (only the six kinds of CED-WA-KIND-ALLOWLIST exist, there is no recipient field), the agent's control
// of the conversation, that the complaint and the buttons' refs are the session's, and `LAM-ONCE-PER-EVENT`
// (a second `COMPLAINT_UPDATE` for the event that opened the turn is `CONFLICT`). Here:
//
//   - the recipient is the customer of the session: the request names the customer, the gate resolves
//     the phone; nothing the model writes can change it;
//   - "Hablar con alguien" (`TALK_TO_HUMAN`) is added by code to every free-text message; WhatsApp shows
//     three reply buttons, so the model may list two besides it; a template keeps its own buttons;
//   - a template's parameters are checked before the gate: `{{3}}` of `reclamo_novedad` outside the
//     closed list → `TEMPLATE_PARAM_NOT_ALLOWED`; any other value not grounded by its kind in this
//     turn's tool results or the message's complaint, exactly as the gate checks it again
//     (outbound/template-grounding.ts: a complaint number, a deadline, a masked email or a first name,
//     each exactly a value) → `GROUNDING_FAIL`;
//   - before the customer is identified, the challenge goes only as its own `IDENTITY_CHALLENGE` and no
//     button that needs identification goes out (identity-guard.ts);
//   - the gate decides (policy, render, G2, verification, fence, tape, send claim, transport) and its
//     decision is the answer: `ALLOWED`, `DEFERRED` (it goes out later by itself), `REROUTED`, or the
//     refusal with its rules.
import { ToolError } from "@reclamo/shared";
import { CopyParamError, TemplateParamNotAllowedError, WHATSAPP_TEMPLATES, templateParameters } from "../../copy";
import { type GroundingFacts, groundingFactsOf, templateParamGrounded } from "../../outbound/template-grounding";
import type { OutboundButton, OutboundGate, OutboundRequest } from "../../outbound/types";
import type { ToolContext, ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import { isIdentified } from "../common/fences";
import { checkBeforeIdentification } from "./identity-guard";
import { gateAnswer, outboundCallOf, turnOf } from "./outbound";
import { MAX_BUTTONS, type MESSAGING_TOOLS } from "./schema";

type SendInput = ToolInput<(typeof MESSAGING_TOOLS)["send_whatsapp"]>;

export interface MessagingPorts {
  /** `sendThroughGate` in the stage. */
  readonly gate: OutboundGate;
}

/** The model's buttons plus "Hablar con alguien", which the code adds and WhatsApp counts among its three. */
export function buttonsWithHuman(buttons: SendInput["buttons"], complaintId: string | undefined): OutboundButton[] {
  const listed = (buttons ?? []).filter((button) => button.action !== "TALK_TO_HUMAN");
  if (listed.length > MAX_BUTTONS - 1) throw new ToolError("INVALID", `at most ${MAX_BUTTONS - 1} buttons besides "Hablar con alguien", which the code adds`, "TOO_MANY_BUTTONS");
  const human: OutboundButton = { action: "TALK_TO_HUMAN", ...(complaintId === undefined ? {} : { ref: complaintId }) };
  return [...listed.map((button) => ({ action: button.action, ...(button.ref === undefined ? {} : { ref: button.ref }) })), human];
}

/**
 * What a template parameter may be copied from: this turn's tool results and the complaint the message
 * is about, the same facts the gate's verification reads (its `ctx.complaint` is this complaint).
 */
async function groundingFacts(ctx: ToolContext<SendInput>, complaintId: string | undefined): Promise<GroundingFacts> {
  const { worldId, turnId, customerId } = ctx.session;
  const results = (await ctx.connector.sessions.listTurnResults(worldId, turnId)).map((row) => row.result);
  const complaint = complaintId === undefined ? undefined : await ctx.connector.complaints.get(worldId, complaintId);
  return groundingFactsOf(results, complaint === undefined || complaint.customerId !== customerId ? undefined : complaint);
}

/** Validates the parameters of a template the way the gate renders them; refuses before anything is sent. */
async function checkTemplate(ctx: ToolContext<SendInput>, template: NonNullable<SendInput["template"]>, complaintId: string | undefined): Promise<void> {
  const params = template.params ?? [];
  try {
    templateParameters(template.name, params);
  } catch (error) {
    if (error instanceof TemplateParamNotAllowedError) throw new ToolError("TEMPLATE_PARAM_NOT_ALLOWED", error.message, "STATUS_PHRASE_NOT_IN_LIST");
    if (error instanceof CopyParamError) throw new ToolError("INVALID", `the parameters of ${template.name} do not fit the template`, error.code);
    throw error;
  }
  const kinds = WHATSAPP_TEMPLATES[template.name].params;
  const facts = await groundingFacts(ctx, complaintId);
  params.forEach((value, index) => {
    const kind = kinds[index];
    if (kind === undefined || templateParamGrounded(kind, value, facts)) return;
    throw new ToolError("GROUNDING_FAIL", `parameter {{${index + 1}}} of ${template.name} is not in this turn's tool results`, "TEMPLATE_PARAM_UNGROUNDED");
  });
}

/** The complaint a message is about: the one named, else the session's only one. */
function complaintOf(ctx: ToolContext<SendInput>): string | undefined {
  if (ctx.input.complaintId !== undefined) return ctx.input.complaintId;
  return ctx.session.complaintIds.length === 1 ? ctx.session.complaintIds[0] : undefined;
}

export function sendWhatsAppTool(ports: MessagingPorts): ToolImplementation<SendInput> {
  return async (ctx) => {
    const { input, session } = ctx;
    const complaintId = complaintOf(ctx);
    const conversation = ctx.conversation ?? (await ctx.connector.conversations.getMeta(session.worldId, session.customerId, { consistent: true }));
    if (!isIdentified(conversation, ctx.wallClock())) checkBeforeIdentification(input);
    if (input.template !== undefined) await checkTemplate(ctx, input.template, complaintId);
    const request: OutboundRequest = {
      worldId: session.worldId,
      customerId: session.customerId,
      ...(complaintId === undefined ? {} : { complaintId }),
      sender: "AGENT",
      channel: "WHATSAPP",
      kind: input.kind,
      ...(input.text === undefined ? {} : { text: input.text }),
      // A template's buttons are fixed by the template: whatever the model listed next to one is ignored.
      ...(input.template === undefined
        ? { buttons: buttonsWithHuman(input.buttons, complaintId) }
        : { template: { name: input.template.name, params: [...(input.template.params ?? [])] } }),
      refs: { tool: ctx.tool, ...(complaintId === undefined ? {} : { complaintId }) },
      ...turnOf(ctx),
    };
    const outcome = await ports.gate(request, outboundCallOf(ctx));
    await ctx.audit({
      action: "SEND_WHATSAPP",
      outcome: outcome.ok ? outcome.decision : (outcome.decision ?? outcome.failure.error.code),
      ruleIds: [...outcome.ruleIds],
      refs: {
        kind: input.kind,
        ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
        ...(complaintId === undefined ? {} : { complaintId }),
        ...(outcome.ok && outcome.decision === "ALLOWED" && outcome.replayOf !== undefined ? { replayOf: outcome.replayOf } : {}),
      },
    });
    return gateAnswer(outcome);
  };
}
