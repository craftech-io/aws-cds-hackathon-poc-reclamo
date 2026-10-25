// The Meta Cloud API message every WhatsApp send carries (docs/architecture-integrations.md §3.1): the
// JSON `SendWhatsAppMessage` takes as bytes in live mode, which the simulated transport validates with
// the same schema (§3.2). Three shapes: text (`preview_url: false`), interactive (up to three reply
// buttons of ≤ 20 characters, or a list of up to ten rows of ≤ 24) and a `UTILITY` template in
// `es_AR` whose quick replies carry a nonce as payload. The builders enforce Meta's limits and the
// closed parameter lists of copy/templates.ts, so an invalid message fails here, never at Meta.
import { z } from "zod";
import { BUTTON_TITLE_LIMIT, TemplateName, WHATSAPP_TEMPLATES, charCount, renderTemplateBody, templateParameters } from "../../copy";
import { MESSAGING_PRODUCT, TEMPLATE_LANGUAGE_CODE } from "./config";

/** Body of a text message and of an interactive one; a list row's description (Meta). */
export const TEXT_BODY_MAX_CHARS = 4_096;
export const INTERACTIVE_BODY_MAX_CHARS = 1_024;
export const ROW_DESCRIPTION_MAX_CHARS = 72;
export const MAX_REPLY_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;

const chars = (max: number) => z.string().min(1).refine((value) => charCount(value) <= max, `at most ${max} characters`);
/** `to`: the recipient's number as Meta writes a `wa_id` (digits, no `+`). */
const To = z.string().regex(/^\d{8,15}$/, "expected the recipient's number without '+'");
/** Ids of reply buttons and list rows, and quick-reply payloads: our nonces (`Runtime/NONCE#`). */
export const ReplyId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "expected a nonce");
const envelopeFields = { messaging_product: z.literal(MESSAGING_PRODUCT), recipient_type: z.literal("individual"), to: To };

const TextMessage = z.strictObject({
  ...envelopeFields,
  type: z.literal("text"),
  text: z.strictObject({ preview_url: z.literal(false), body: chars(TEXT_BODY_MAX_CHARS) }),
});

const ButtonsInteractive = z.strictObject({
  type: z.literal("button"),
  body: z.strictObject({ text: chars(INTERACTIVE_BODY_MAX_CHARS) }),
  action: z.strictObject({
    buttons: z
      .array(z.strictObject({ type: z.literal("reply"), reply: z.strictObject({ id: ReplyId, title: chars(BUTTON_TITLE_LIMIT.INTERACTIVE) }) }))
      .min(1)
      .max(MAX_REPLY_BUTTONS),
  }),
});

const ListInteractive = z.strictObject({
  type: z.literal("list"),
  body: z.strictObject({ text: chars(INTERACTIVE_BODY_MAX_CHARS) }),
  action: z.strictObject({
    button: chars(BUTTON_TITLE_LIMIT.LIST_MENU),
    sections: z
      .array(
        z.strictObject({
          rows: z
            .array(z.strictObject({ id: ReplyId, title: chars(BUTTON_TITLE_LIMIT.LIST_ROW), description: chars(ROW_DESCRIPTION_MAX_CHARS).optional() }))
            .min(1)
            .max(MAX_LIST_ROWS),
        }),
      )
      .length(1),
  }),
});

const InteractiveMessage = z.strictObject({
  ...envelopeFields,
  type: z.literal("interactive"),
  interactive: z.discriminatedUnion("type", [ButtonsInteractive, ListInteractive]),
});

const BodyComponent = z.strictObject({ type: z.literal("body"), parameters: z.array(z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(300) })) });
const QuickReplyComponent = z.strictObject({
  type: z.literal("button"),
  sub_type: z.literal("quick_reply"),
  index: z.string().regex(/^\d$/),
  parameters: z.tuple([z.strictObject({ type: z.literal("payload"), payload: ReplyId })]),
});

const TemplateMessage = z.strictObject({
  ...envelopeFields,
  type: z.literal("template"),
  template: z.strictObject({
    name: TemplateName,
    language: z.strictObject({ code: z.literal(TEMPLATE_LANGUAGE_CODE) }),
    components: z.array(z.union([BodyComponent, QuickReplyComponent])),
  }),
});
type TemplateComponent = z.infer<typeof TemplateMessage>["template"]["components"][number];

/** The template's parameters and buttons have to match its definition in copy/templates.ts exactly. */
function templateProblem(name: TemplateName, components: readonly TemplateComponent[]): string | undefined {
  const definition = WHATSAPP_TEMPLATES[name];
  const bodies = components.filter((component) => component.type === "body");
  if (bodies.length > 1) return `${name} has more than one body component`;
  const params = bodies[0]?.parameters.length ?? 0;
  if (params !== definition.params.length) return `${name} takes ${definition.params.length} parameters, got ${params}`;
  const buttons = components.filter((component) => component.type === "button");
  if (buttons.length !== definition.buttons.length) return `${name} has ${definition.buttons.length} buttons, got ${buttons.length}`;
  if (buttons.some((button, position) => button.index !== String(position))) return `${name} buttons must be indexed in order`;
  return undefined;
}

/** Every message a transport accepts; the simulated one validates with this same schema (§3.2). */
export const MetaMessage = z.discriminatedUnion("type", [TextMessage, InteractiveMessage, TemplateMessage]).superRefine((message, ctx) => {
  if (message.type !== "template") return;
  const problem = templateProblem(message.template.name, message.template.components);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem, path: ["template"] });
});
export type MetaMessage = z.infer<typeof MetaMessage>;

// ---- Builders ---------------------------------------------------------------------------------------

export interface ReplyButton {
  /** The nonce the customer's tap sends back. */
  readonly id: string;
  readonly title: string;
}

export interface ListRow extends ReplyButton {
  readonly description?: string;
}

/** What the gate renders; the transport adds the recipient (`to`) it alone resolves. */
export type WaOutbound =
  | { readonly kind: "text"; readonly body: string }
  | { readonly kind: "buttons"; readonly body: string; readonly buttons: readonly ReplyButton[] }
  | { readonly kind: "list"; readonly body: string; readonly buttonTitle: string; readonly rows: readonly ListRow[] }
  /** `values`: one per parameter, a `STATUS_PHRASE` as its phrase id; `nonces`: one per quick reply, in order. */
  | { readonly kind: "template"; readonly name: TemplateName; readonly values: readonly string[]; readonly nonces: readonly string[] };

/** `+5491100001001` → `5491100001001`, the form Meta uses in `to`. */
export function recipientOf(phoneE164: string): string {
  return phoneE164.replace(/^\+/, "");
}

function templateComponents(name: TemplateName, values: readonly string[], nonces: readonly string[]): TemplateComponent[] {
  const definition = WHATSAPP_TEMPLATES[name];
  if (nonces.length !== definition.buttons.length) throw new RangeError(`${name} has ${definition.buttons.length} buttons, got ${nonces.length} nonces`);
  const params = templateParameters(name, values);
  const body: TemplateComponent[] = params.length === 0 ? [] : [{ type: "body", parameters: params.map((text) => ({ type: "text" as const, text })) }];
  const buttons: TemplateComponent[] = nonces.map((payload, position) => ({ type: "button", sub_type: "quick_reply", index: String(position), parameters: [{ type: "payload", payload }] }));
  return [...body, ...buttons];
}

function unvalidated(outbound: WaOutbound, toE164: string): unknown {
  const envelope = { messaging_product: MESSAGING_PRODUCT, recipient_type: "individual", to: recipientOf(toE164) };
  switch (outbound.kind) {
    case "text":
      return { ...envelope, type: "text", text: { preview_url: false, body: outbound.body } };
    case "buttons":
      return { ...envelope, type: "interactive", interactive: { type: "button", body: { text: outbound.body }, action: { buttons: outbound.buttons.map((button) => ({ type: "reply", reply: { id: button.id, title: button.title } })) } } };
    case "list":
      return {
        ...envelope,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: outbound.body },
          action: { button: outbound.buttonTitle, sections: [{ rows: outbound.rows.map((row) => ({ id: row.id, title: row.title, ...(row.description === undefined ? {} : { description: row.description }) })) }] },
        },
      };
    case "template":
      return { ...envelope, type: "template", template: { name: outbound.name, language: { code: TEMPLATE_LANGUAGE_CODE }, components: templateComponents(outbound.name, outbound.values, outbound.nonces) } };
  }
}

/**
 * The Meta JSON of `outbound` to `toE164`, validated: throws a ZodError, a RangeError or
 * `TEMPLATE_PARAM_NOT_ALLOWED` (copy/templates.ts) instead of building an invalid one.
 */
export function toMetaMessage(outbound: WaOutbound, toE164: string): MetaMessage {
  return MetaMessage.parse(unvalidated(outbound, toE164));
}

/** The text the customer reads, the source of the tape's `payloadHash` (a template renders its body). */
export function renderedTextOf(outbound: WaOutbound): string {
  return outbound.kind === "template" ? renderTemplateBody(outbound.name, outbound.values) : outbound.body;
}

/** The bytes `SendWhatsAppMessage.message` takes. */
export function metaMessageBytes(message: MetaMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

/**
 * What `SendWhatsAppMessage` takes: the Meta JSON with the recipient in E.164 (`+` first). End User
 * Messaging Social refuses Meta's bare digits, so the `+` is added here, at the AWS boundary; the
 * message itself keeps Meta's format (simulator, fixtures, nonces).
 */
export function eumMessageBytes(message: MetaMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ...message, to: `+${message.to}` }));
}

/** The nonces a message carries (quick-reply payloads, reply-button and list-row ids). */
export function noncesOf(message: MetaMessage): string[] {
  if (message.type === "text") return [];
  if (message.type === "template") return message.template.components.flatMap((component) => (component.type === "button" ? [component.parameters[0].payload] : []));
  const interactive = message.interactive;
  return interactive.type === "button" ? interactive.action.buttons.map((button) => button.reply.id) : interactive.action.sections.flatMap((section) => section.rows.map((row) => row.id));
}
