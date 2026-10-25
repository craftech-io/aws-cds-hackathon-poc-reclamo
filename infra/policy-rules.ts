// Cedar policies of the AgentCore Policy engine (docs/design-brief.md §8.6, docs/architecture.md §9.2 and
// §16, docs/build-plan.md WP-31) as plain data: the `CED-*` statements, the checks every statement must
// pass and a local evaluator of the small Cedar subset they are written in (tests use it; the Gateway
// evaluates the real thing).
//
// What Cedar sees on an AWS_IAM Gateway:
//   principal  AgentCore::IamEntity "arn:aws:sts::<account>:assumed-role/<role>", the Harness execution
//              role, the Gateway's only caller
//   action     AgentCore::Action "<target>___<tool>", one per Gateway tool (28)
//   resource   AgentCore::Gateway "<gatewayArn>"
//   context    only `context.input`, the tool arguments typed from the tool's JSON schema (a string array
//              is a Set of String)
// Cedar is default-deny and forbid-wins. Whatever depends on the session (customer, complaint, recipient,
// evidence, caps) is checked by the target Lambdas (`LAM-*`); Cedar holds the static fences.
//
// What the engine imposes (docs/architecture.md §16):
//   - a statement may not exceed 10,000 characters once each action is qualified with the Gateway, so
//     the permit and the session forbid are one policy per target;
//   - a forbid created while no permit covers its action is "Overly Restrictive": permits first, every
//     forbid after all of them (`creationPlan`, applied by infra/policy.ts);
//   - each statement is validated against the Gateway's tool schemas, so every field it cites must be
//     declared there with the type it is used as (`schemaProblems`, run by infra/policy.ts at deploy);
//   - reading an absent field is an evaluation error and Cedar skips an erroring policy: a forbid that
//     read a field without `context.input has <field>` first would fall through to the permit.
//
// The allowlists are the zod enums of the tools (single source). No SST dependency: policy-rules.test.ts
// checks all of this without an AWS account.
import { AnswerAttachment } from "../packages/bff/src/agent-tools/complaints/schema";
import { AgentWhatsAppKind } from "../packages/bff/src/agent-tools/messaging/schema";
import { GATEWAY_TOOLS, ToolTarget, gatewayActionOf, targetOf, type CedarStatementId, type GatewayToolName } from "../packages/bff/src/agent-tools/common/targets";

/** Gateway targets in chain order; each `GatewayTarget` must be named exactly like this. */
export const GATEWAY_TARGETS: readonly ToolTarget[] = ToolTarget.options;

/**
 * CED-KILL-SWITCH. The policy always exists; while this is `false` its condition is `false` and it denies
 * nothing. It is the SECOND layer: the first-line cut is `KILL#AGENT` at runtime, without a deploy
 * (docs/design-brief.md §8.1). Turning it on is an IaC change through CI, never a console action.
 */
export const KILL_SWITCH_ACTIVE = false;

/** Engine limit per statement, once every action is qualified with the Gateway ARN. */
export const MAX_STATEMENT_CHARS = 10_000;

/** The four money tools: their amount comes from the core, never from a `capOverride` (LAM-CAP). */
export const MONEY_TOOLS = ["apply_payment", "reverse_charge", "refund_duplicate_debit", "request_transfer_reversal"] as const satisfies readonly GatewayToolName[];

export type CedarPolicyId = `CED-PERMIT-${Uppercase<ToolTarget>}` | `CED-SESSION-${Uppercase<ToolTarget>}` | CedarStatementId | "CED-KILL-SWITCH";

export const cedarPermitId = (target: ToolTarget): CedarPolicyId => `CED-PERMIT-${target.toUpperCase() as Uppercase<ToolTarget>}`;
export const cedarSessionId = (target: ToolTarget): CedarPolicyId => `CED-SESSION-${target.toUpperCase() as Uppercase<ToolTarget>}`;

export type CedarEffect = "permit" | "forbid";
export type CedarEnforcementMode = "ACTIVE" | "LOG_ONLY";
export type CedarValidationMode = "FAIL_ON_ANY_FINDINGS" | "IGNORE_ALL_FINDINGS";

export interface CedarPolicyDefinition {
  readonly id: CedarPolicyId;
  /** Resource name in the engine: `^[A-Za-z][A-Za-z0-9_]*$`, at most 48 characters with the app prefix. */
  readonly name: string;
  readonly effect: CedarEffect;
  readonly description: string;
  readonly statement: string;
  readonly enforcementMode: CedarEnforcementMode;
  readonly validationMode: CedarValidationMode;
}

export interface CedarPolicyInputs {
  readonly gatewayArn: string;
  /** Cedar entity id of the Harness execution role (`assumedRoleEntityId`). */
  readonly harnessPrincipalId: string;
}

export interface CedarPolicyOptions {
  readonly killSwitchActive?: boolean;
}

/** Entity id Cedar gives an assumed IAM role, stable across session names. */
export function assumedRoleEntityId(accountId: string, roleName: string): string {
  return `arn:aws:sts::${accountId}:assumed-role/${roleName}`;
}

/** `CED-NO-SELF-APPROVAL` → `CED_NO_SELF_APPROVAL`, the only characters a Policy name accepts. */
export function policyName(id: CedarPolicyId): string {
  return id.replace(/-/g, "_");
}

/** Name of the engine: `^[A-Za-z][A-Za-z0-9_]*$`, at most 48 characters. */
export function policyEngineName(app: string, stage: string): string {
  return `${app}_${stage}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
}

/** `<target>___<tool>` of a Gateway tool. */
export function actionId(tool: GatewayToolName): string {
  const target = targetOf(tool);
  if (target === undefined) throw new Error(`No Gateway target declares ${tool}.`);
  return gatewayActionOf(target, tool);
}

/** Every Gateway action id, in target order. */
export function allActionIds(): string[] {
  return GATEWAY_TARGETS.flatMap((target) => GATEWAY_TOOLS[target].map((tool) => gatewayActionOf(target, tool)));
}

// ---- Terms of the subset ------------------------------------------------------------------------------

export type CedarTerm =
  | { readonly kind: "has"; readonly field: string }
  /** `["a", "b"].contains(context.input.field)`: the field (a String) is one of the values. */
  | { readonly kind: "oneOf"; readonly field: string; readonly values: readonly string[]; readonly negated: boolean }
  /** `["a", "b"].containsAll(context.input.field)`: every element of the field (a Set of String) is one of the values. */
  | { readonly kind: "subsetOf"; readonly field: string; readonly values: readonly string[]; readonly negated: boolean }
  | { readonly kind: "false" };

export interface CedarCondition {
  readonly kind: "when" | "unless";
  /** Joined with `&&`, evaluated left to right with short-circuit. */
  readonly terms: readonly CedarTerm[];
}

const has = (field: string): CedarTerm => ({ kind: "has", field });
const oneOf = (field: string, values: readonly string[]): CedarTerm => ({ kind: "oneOf", field, values, negated: false });
const notSubsetOf = (field: string, values: readonly string[]): CedarTerm => ({ kind: "subsetOf", field, values, negated: true });

const SET_METHOD = { oneOf: "contains", subsetOf: "containsAll" } as const;

function renderTerm(term: CedarTerm): string {
  switch (term.kind) {
    case "false":
      return "false";
    case "has":
      return `context.input has ${term.field}`;
    default:
      return `${term.negated ? "!" : ""}[${term.values.map((value) => `"${value}"`).join(", ")}].${SET_METHOD[term.kind]}(context.input.${term.field})`;
  }
}

function renderActions(tools: readonly GatewayToolName[]): string {
  const [only] = tools;
  if (tools.length === 1 && only !== undefined) return `action == AgentCore::Action::"${actionId(only)}"`;
  return `action in [\n${tools.map((tool) => `    AgentCore::Action::"${actionId(tool)}"`).join(",\n")}\n  ]`;
}

function render(id: CedarPolicyId, effect: CedarEffect, inputs: CedarPolicyInputs, tools: readonly GatewayToolName[], condition?: CedarCondition): string {
  const scope = `principal == AgentCore::IamEntity::"${inputs.harnessPrincipalId}",\n  ${renderActions(tools)},\n  resource == AgentCore::Gateway::"${inputs.gatewayArn}"`;
  const body = condition === undefined ? "" : `\n${condition.kind} {\n  ${condition.terms.map(renderTerm).join(" &&\n  ")}\n}`;
  return `// ${id}\n${effect}(\n  ${scope}\n)${body};`;
}

const ALL_TOOLS: readonly GatewayToolName[] = GATEWAY_TARGETS.flatMap((target) => GATEWAY_TOOLS[target]);

/**
 * The Cedar policies, permits first. Every statement is scoped to the Gateway ARN (so the engine validates
 * it against that Gateway's schemas) and names the Harness principal, the only one a permit allows.
 */
export function cedarPolicies(inputs: CedarPolicyInputs, options: CedarPolicyOptions = {}): CedarPolicyDefinition[] {
  const killSwitchActive = options.killSwitchActive ?? KILL_SWITCH_ACTIVE;
  const policy = (id: CedarPolicyId, effect: CedarEffect, tools: readonly GatewayToolName[], description: string, validationMode: CedarValidationMode, condition?: CedarCondition): CedarPolicyDefinition => ({
    id,
    name: policyName(id),
    effect,
    description,
    statement: render(id, effect, inputs, tools, condition),
    enforcementMode: "ACTIVE",
    validationMode,
  });

  // An unconditional allowlist reads "overly permissive" until the forbids that narrow it exist, and those
  // need it first: schema validation still runs, the field forbids fail on any finding.
  const permits = GATEWAY_TARGETS.map((target) =>
    policy(cedarPermitId(target), "permit", GATEWAY_TOOLS[target], `Only the Harness role may call the ${target} tools, and only these; anything else falls to default deny.`, "IGNORE_ALL_FINDINGS"),
  );
  // Every Gateway schema already requires sessionToken, so the analyzer may call these ineffective; they
  // stay as defense in depth should a schema ever lose the field.
  const sessions = GATEWAY_TARGETS.map((target) =>
    policy(cedarSessionId(target), "forbid", GATEWAY_TOOLS[target], `A ${target} tool call must carry the signed sessionToken; identity never comes from what the model writes.`, "IGNORE_ALL_FINDINGS", {
      kind: "unless",
      terms: [has("sessionToken")],
    }),
  );

  return [
    ...permits,
    ...sessions,
    policy("CED-WA-KIND-ALLOWLIST", "forbid", ["send_whatsapp"], "send_whatsapp only with a kind of the allowlist; collection kinds can never be sent by WhatsApp.", "FAIL_ON_ANY_FINDINGS", {
      kind: "unless",
      terms: [has("kind"), oneOf("kind", AgentWhatsAppKind.options)],
    }),
    policy("CED-ATTACHMENTS-ALLOWLIST", "forbid", ["answer_complaint_in_writing"], "The written answer attaches only documents of the allowlist; the code adds or removes by eligibility.", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("requestedAttachments"), notSubsetOf("requestedAttachments", AnswerAttachment.options)],
    }),
    policy("CED-NO-SELF-APPROVAL", "forbid", ["request_operator_approval"], "The agent never decides an approval: request_operator_approval with `decision` is denied (ADR-0005).", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("decision")],
    }),
    policy("CED-NO-CAP-OVERRIDE", "forbid", MONEY_TOOLS, "A money tool never takes a cap override: the amount and the cap come from the core and the world (LAM-CAP).", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("capOverride")],
    }),
    // Unconditional forbid when active, never-applying when not: either way the analyzer has a finding.
    policy(
      "CED-KILL-SWITCH",
      "forbid",
      ALL_TOOLS,
      `Kill switch, ${killSwitchActive ? "ACTIVE: every Gateway call of the Harness is denied" : "off: denies nothing until KILL_SWITCH_ACTIVE is true in infra/policy-rules.ts"}.`,
      "IGNORE_ALL_FINDINGS",
      killSwitchActive ? undefined : { kind: "when", terms: [{ kind: "false" }] },
    ),
  ];
}

export interface PolicyCreationStep {
  readonly definition: CedarPolicyDefinition;
  /** Names of the policies this one must be created after. */
  readonly after: readonly string[];
}

/** Permits first and independent; every forbid after all the permits. */
export function creationPlan(policies: readonly CedarPolicyDefinition[]): PolicyCreationStep[] {
  const permitNames = policies.filter((policy) => policy.effect === "permit").map((policy) => policy.name);
  return [
    ...policies.filter((policy) => policy.effect === "permit").map((definition) => ({ definition, after: [] })),
    ...policies.filter((policy) => policy.effect === "forbid").map((definition) => ({ definition, after: permitNames })),
  ];
}

// ---- Parsing the rendered subset ----------------------------------------------------------------------

export interface ParsedStatement {
  readonly id: string;
  readonly effect: CedarEffect;
  readonly principal: string;
  readonly actions: readonly string[];
  readonly resource: string;
  readonly condition?: CedarCondition;
}

const STATEMENT =
  /^\/\/ (CED-[A-Z-]+)\n(permit|forbid)\(\n {2}principal == AgentCore::IamEntity::"([^"]+)",\n {2}(action == AgentCore::Action::"[^"]+"|action in \[\n[^\]]+\n {2}\]),\n {2}resource == AgentCore::Gateway::"([^"]+)"\n\)(?:\n(when|unless) \{\n([\s\S]+?)\n\})?;$/;
const SET_TERM = /^(!?)\[((?:"[A-Z_]+"(?:, )?)+)\]\.(contains|containsAll)\(context\.input\.([A-Za-z_][A-Za-z0-9_]*)\)$/;

function parseTerm(text: string): CedarTerm {
  if (text === "false") return { kind: "false" };
  const presence = /^context\.input has ([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (presence?.[1] !== undefined) return has(presence[1]);
  const set = SET_TERM.exec(text);
  if (set?.[2] !== undefined && set[4] !== undefined) {
    const values = [...set[2].matchAll(/"([A-Z_]+)"/g)].map((value) => value[1] ?? "");
    return { kind: set[3] === "contains" ? "oneOf" : "subsetOf", field: set[4], values, negated: set[1] === "!" };
  }
  throw new Error(`Unsupported Cedar term "${text}": only \`context.input has f\`, [..].contains/containsAll(context.input.f) and \`false\`.`);
}

/** Parses a statement rendered by `cedarPolicies`; anything outside that subset throws. */
export function parseStatement(statement: string): ParsedStatement {
  const match = STATEMENT.exec(statement);
  if (match === null) throw new Error(`Statement outside the supported Cedar subset:\n${statement}`);
  const [, id = "", effect = "", principal = "", actions = "", resource = "", kind, body] = match;
  const condition: CedarCondition | undefined = kind === "when" || kind === "unless" ? { kind, terms: (body ?? "").split("&&").map((term) => parseTerm(term.trim())) } : undefined;
  return {
    id,
    effect: effect === "permit" ? "permit" : "forbid",
    principal,
    actions: [...actions.matchAll(/AgentCore::Action::"([^"]+)"/g)].map((action) => action[1] ?? ""),
    resource,
    ...(condition === undefined ? {} : { condition }),
  };
}

// ---- Local evaluation ---------------------------------------------------------------------------------

export interface CedarRequest {
  readonly principal: string;
  readonly action: string;
  readonly resource: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface CedarDecision {
  readonly decision: "ALLOW" | "DENY";
  /** Names of the policies that decided (the forbids that applied, or the permits). */
  readonly determining: readonly string[];
  /** Names of the policies skipped because their condition failed to evaluate. */
  readonly errors: readonly string[];
}

/** One term against the input: `error` for a read of an absent field or a set operation on a non-set. */
function termHolds(term: CedarTerm, input: Readonly<Record<string, unknown>>): boolean | "error" {
  if (term.kind === "false") return false;
  const present = Object.hasOwn(input, term.field);
  if (term.kind === "has") return present;
  if (!present) return "error";
  const value = input[term.field];
  let holds: boolean;
  if (term.kind === "oneOf") holds = term.values.includes(value as string);
  else if (Array.isArray(value)) holds = value.every((item) => term.values.includes(item as string));
  else return "error";
  return term.negated ? !holds : holds;
}

function conditionHolds(terms: readonly CedarTerm[], input: Readonly<Record<string, unknown>>): boolean | "error" {
  for (const term of terms) {
    const holds = termHolds(term, input);
    if (holds !== true) return holds;
  }
  return true;
}

/** Cedar's decision for the policies that are `ACTIVE`: forbid wins, then permit, else default deny. */
export function evaluateCedar(policies: readonly CedarPolicyDefinition[], request: CedarRequest): CedarDecision {
  const applied: Record<CedarEffect, string[]> = { permit: [], forbid: [] };
  const errors: string[] = [];
  for (const policy of policies) {
    if (policy.enforcementMode !== "ACTIVE") continue;
    const parsed = parseStatement(policy.statement);
    if (parsed.principal !== request.principal || parsed.resource !== request.resource || !parsed.actions.includes(request.action)) continue;
    const holds = parsed.condition === undefined ? true : conditionHolds(parsed.condition.terms, request.input);
    if (holds === "error") {
      errors.push(policy.name);
      continue;
    }
    if (parsed.condition === undefined || (parsed.condition.kind === "when") === holds) applied[parsed.effect].push(policy.name);
  }
  if (applied.forbid.length > 0) return { decision: "DENY", determining: applied.forbid, errors };
  return { decision: applied.permit.length > 0 ? "ALLOW" : "DENY", determining: applied.permit, errors };
}

// ---- Checks against the Gateway schemas ---------------------------------------------------------------

export interface ToolInputSchema {
  readonly properties?: Readonly<Record<string, { readonly type?: string; readonly items?: { readonly type?: string } }>>;
}

/** Input schema of every Gateway action, keyed by action id (`<target>___<tool>`). */
export type ToolInputSchemas = Readonly<Record<string, ToolInputSchema>>;

/** One entry of a target's `inlinePayload`, as far as Cedar cares. */
export interface GatewayToolSchema {
  readonly name: string;
  readonly inputSchema: ToolInputSchema;
}

export function inputSchemasByAction(payloads: Readonly<Record<ToolTarget, readonly GatewayToolSchema[]>>): ToolInputSchemas {
  const schemas: Record<string, ToolInputSchema> = {};
  for (const target of GATEWAY_TARGETS) for (const tool of payloads[target]) schemas[gatewayActionOf(target, tool.name)] = tool.inputSchema;
  return schemas;
}

/** Fields a statement reads (`.contains(context.input.<field>)`…) with no earlier `has` of the same condition. */
export function unguardedReads(statement: string): string[] {
  const guarded = new Set<string>();
  const unguarded: string[] = [];
  for (const term of parseStatement(statement).condition?.terms ?? []) {
    if (term.kind === "has") guarded.add(term.field);
    else if (term.kind !== "false" && !guarded.has(term.field)) unguarded.push(term.field);
  }
  return unguarded;
}

/** The type a term needs its field to have in the Gateway schema, or `undefined` when any declared type will do. */
function typeProblem(term: CedarTerm, property: { readonly type?: string; readonly items?: { readonly type?: string } }): string | undefined {
  if (term.kind === "oneOf" && property.type !== "string") return `is compared with strings but is ${property.type ?? "untyped"}`;
  if (term.kind === "subsetOf" && (property.type !== "array" || property.items?.type !== "string")) return `is used as a set of strings but is ${property.type ?? "untyped"}`;
  return undefined;
}

/**
 * Everything the engine would reject or that would silently weaken a fence: a read without `has`, an
 * action without a Gateway schema, a cited field the schema does not declare or declares with another
 * type, and a Gateway tool that no permit names.
 */
export function schemaProblems(policies: readonly CedarPolicyDefinition[], schemas: ToolInputSchemas): string[] {
  const problems: string[] = [];
  const permitted = new Set<string>();
  for (const policy of policies) {
    const parsed = parseStatement(policy.statement);
    if (parsed.effect === "permit") for (const action of parsed.actions) permitted.add(action);
    for (const field of unguardedReads(policy.statement)) problems.push(`${policy.id}: context.input.${field} is read without "context.input has ${field}" first`);
    for (const action of parsed.actions) {
      const properties = schemas[action]?.properties;
      if (properties === undefined) {
        problems.push(`${policy.id}: no Gateway input schema for ${action}`);
        continue;
      }
      for (const term of parsed.condition?.terms ?? []) {
        if (term.kind === "false") continue;
        const property = properties[term.field];
        if (property === undefined) {
          problems.push(`${policy.id}: ${action} declares no input field "${term.field}"`);
          continue;
        }
        const problem = typeProblem(term, property);
        if (problem !== undefined) problems.push(`${policy.id}: ${action}.${term.field} ${problem}`);
      }
    }
  }
  for (const action of Object.keys(schemas)) if (!permitted.has(action)) problems.push(`Gateway tool ${action} is named by no permit`);
  return problems;
}
