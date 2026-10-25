// How a Gateway tool is declared (docs/tool-catalog.md, docs/design-brief.md §8.6). One definition per
// tool is the single source of:
//
//   - the Gateway schema the model reads (`sessionToken` plus the tool's fields, folded into the
//     `inlinePayload` of its target by gateway-schema.ts / `npm run tools:build-schemas`);
//   - the strict input the target Lambda accepts (`LAM-STRICT`: an undeclared key, a value out of the
//     real enum or a field a Cedar forbid reads → `INVALID`);
//   - the ids of the input and what each one must belong to (`LAM-SCOPE`, scope.ts);
//   - the fences that apply to the tool (`LAM-IDENTIFIED`, `LAM-COMPLAINT-REQUIRED`, `LAM-CONTROL`,
//     `LAM-ONCE-PER-EVENT`, fences.ts) and the in-process callers it admits besides the Harness;
//   - the output fields that carry free text of the mocks or of a customer image, escaped as data.
//
// Pure on purpose (zod and @reclamo/shared only): the SST program loads the definitions, so nothing
// here may reach the connector, the SDKs or `Resource`.
import { z } from "zod";
import { type CallerKind, type ComplaintType, Id } from "@reclamo/shared";
import type { CedarStatementId, GatewayToolName } from "./targets";

/** JSON types a node of a Gateway schema may declare. */
export type GatewayType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface DeniedField {
  readonly type: GatewayType;
  readonly ruleId: CedarStatementId;
}

const DENIED_FIELDS = new WeakMap<object, DeniedField>();

/**
 * A field a Cedar forbid reads (`decision` for CED-NO-SELF-APPROVAL, `capOverride` for
 * CED-NO-CAP-OVERRIDE). Cedar validates a statement against the Gateway schema and a forbid that reads an
 * undeclared field is invalid, so the field is declared there, optional and documented as never set; zod
 * refuses it with any value, so the Lambda refuses it even without Cedar (`LAM-STRICT`).
 */
export function deniedByPolicy(type: GatewayType, ruleId: CedarStatementId) {
  const schema = z.never().optional().describe("never set; denied by policy");
  DENIED_FIELDS.set(schema, { type, ruleId });
  return schema;
}

/** The Gateway declaration of a field made with `deniedByPolicy`, if it is one. */
export function deniedFieldOf(schema: object): DeniedField | undefined {
  return DENIED_FIELDS.get(schema);
}

/** Free text of bounded length; the bound reaches the model through the description. */
export function boundedText(max: number, description: string) {
  return z.string().trim().min(1).max(max).describe(description);
}

/** An id the model copies from a tool result of this turn; what it must belong to is declared in `scoped`. */
export function idField(description: string) {
  return Id.describe(description);
}

/** The optional complaint of a call: copied from <facts> or a tool result, never the R- number. */
export function complaintIdField() {
  return idField("The id attribute of a <complaint> fact (or a complaintId a tool returned), never its R- number; optional when the session has only one open.").optional();
}

/** What the model reads about `sessionToken`, the same on the 28 tools. */
export const SESSION_TOKEN_DESCRIPTION = "Token of this turn, copied verbatim from the session line of the turn envelope. Required in every call; never write it yourself.";

export const SessionTokenField = z.string().min(1).max(400).describe(SESSION_TOKEN_DESCRIPTION);

/**
 * What an id of the input must belong to (`LAM-SCOPE`): a complaint of the session, an evidence of one of
 * them, an inbound message or a button nonce of the session's customer, or a loan, charge, transfer or
 * wallet movement the core says is the customer's. `BUTTON_REF` is either a complaint of the session or a
 * loan of the customer.
 */
export const ScopeKind = z.enum(["COMPLAINT", "EVIDENCE", "MESSAGE", "NONCE", "LOAN", "CHARGE", "TRANSFER", "MOVEMENT", "BUTTON_REF"]);
export type ScopeKind = z.infer<typeof ScopeKind>;

export interface ToolFences {
  /** `LAM-IDENTIFIED` (**Id** in the catalog): the customer passed the challenge in the last 30 real minutes. */
  readonly identified?: boolean;
  /** `LAM-COMPLAINT-REQUIRED` (**Rc**): an open complaint of the session; `complaintId` optional with only one. */
  readonly complaint?: boolean;
  /**
   * The complaint types an investigation tool investigates: when its input names no complaint, its
   * evidence goes on the newest open complaint of one of these types, never on another type's.
   */
  readonly complaintTypes?: readonly ComplaintType[];
  /** `LAM-CONTROL`: with the conversation in an operator's hands the tool answers `CONTROL_OPERATOR`. */
  readonly control?: boolean;
  /**
   * `LAM-ONCE-PER-EVENT`: the name of the once-per-event claim this input takes, or `undefined` when the
   * rule does not apply to it (`send_whatsapp` takes one only for a `COMPLAINT_UPDATE`).
   */
  readonly oncePerEvent?: (input: Readonly<Record<string, unknown>>) => string | undefined;
}

export interface ToolSpec<N extends GatewayToolName, S extends z.ZodRawShape> {
  readonly name: N;
  /** What the model reads about the tool (the Gateway `description`). */
  readonly description: string;
  /** Arguments the model may write, besides `sessionToken`. */
  readonly fields: S;
  /** Cross-field rules zod checks in the Lambda (the Gateway schema cannot say them). */
  readonly check?: (input: z.output<z.ZodObject<S>>, ctx: z.RefinementCtx) => void;
  /** Path of every id of the input (`complaintId`, `buttons[].ref`) and what it must belong to. */
  readonly scoped?: Readonly<Record<string, ScopeKind>>;
  readonly fences?: ToolFences;
  /** In-process callers besides the Harness (docs/tool-catalog.md "invocan"); they still need the turn's token. */
  readonly callers?: readonly CallerKind[];
  /** Output paths (`operations[].description`) of free text from a mock or an image: escaped as data. */
  readonly untrustedOutput?: readonly string[];
}

export interface ToolDefinition<N extends GatewayToolName = GatewayToolName, S extends z.ZodRawShape = z.ZodRawShape> extends Omit<ToolSpec<N, S>, "check"> {
  /** `sessionToken` plus `fields`, strict and without the cross-field rules: the source of the Gateway schema. */
  readonly gatewayShape: z.ZodObject;
  /** What the Lambda accepts: `gatewayShape` with the cross-field rules. */
  readonly gatewayInput: z.ZodType<Record<string, unknown>>;
  /** Names of the fields declared with `deniedByPolicy`. */
  readonly deniedFields: readonly string[];
  readonly scoped: Readonly<Record<string, ScopeKind>>;
  readonly fences: ToolFences;
  readonly callers: readonly CallerKind[];
  readonly untrustedOutput: readonly string[];
}

/** Keys of the principal; a tool never declares them and the implementation never sees them in its input. */
export const PRINCIPAL_KEYS = ["sessionToken", "caller"] as const;

/** Field names that would let the model choose a recipient: no tool declares one (the session decides). */
export const RECIPIENT_FIELDS = ["recipient", "recipientRole", "to", "phone", "email", "address", "destination"] as const;

function topField(path: string): string {
  return path.split(/[.[]/)[0] ?? path;
}

export function defineTool<const N extends GatewayToolName, S extends z.ZodRawShape>(spec: ToolSpec<N, S>): ToolDefinition<N, S> {
  for (const key of [...PRINCIPAL_KEYS, ...RECIPIENT_FIELDS]) {
    if (key in spec.fields) throw new Error(`${spec.name}: "${key}" may not be declared by a tool`);
  }
  for (const path of Object.keys(spec.scoped ?? {})) {
    if (!(topField(path) in spec.fields)) throw new Error(`${spec.name}: scoped path "${path}" names no field`);
  }
  const deniedFields = Object.entries(spec.fields)
    .filter(([, schema]) => deniedFieldOf(schema) !== undefined)
    .map(([field]) => field);
  const gatewayShape = z.object({ sessionToken: SessionTokenField, ...spec.fields }).strict();
  const { check, ...rest } = spec;
  const gatewayInput = (
    check === undefined ? gatewayShape : gatewayShape.superRefine((input, ctx) => check(input as z.output<z.ZodObject<S>>, ctx))
  ) as z.ZodType<Record<string, unknown>>;
  return {
    ...rest,
    gatewayShape,
    gatewayInput,
    deniedFields,
    scoped: spec.scoped ?? {},
    fences: spec.fences ?? {},
    callers: spec.callers ?? [],
    untrustedOutput: spec.untrustedOutput ?? [],
  };
}

/** The input an implementation receives: the tool's own fields, without `sessionToken`. */
export type ToolInput<T> = T extends ToolDefinition<GatewayToolName, infer S extends z.ZodRawShape> ? z.output<z.ZodObject<S>> : never;
