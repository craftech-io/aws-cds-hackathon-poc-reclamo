// Which IAM grants reach SES receiving, a custom MAIL FROM or Mail Manager ingress (ADR-0003), for
// scripts/lint/no-ses-receiving.ts. A grant is assessed by what it COVERS, not by how it is spelled:
// `ses:*`, `ses:Create*`, `*` or an `Allow` with `NotAction` reach `ses:CreateReceiptRule` as surely as
// naming it. Such a grant is accepted only when the same role's policy set (its inline and attached
// policies and its permissions boundary) carries an unconditional `Deny` on `Resource: "*"` that
// covers every receiving action the grant reaches.
import { parse } from "yaml";

/** The receiving, MAIL FROM and Mail Manager ingress actions a grant must never reach (IAM prefix `ses:`). */
export const RECEIVING_ACTIONS = [
  "ses:CloneReceiptRuleSet",
  "ses:CreateReceiptFilter",
  "ses:CreateReceiptRule",
  "ses:CreateReceiptRuleSet",
  "ses:DeleteReceiptFilter",
  "ses:DeleteReceiptRule",
  "ses:DeleteReceiptRuleSet",
  "ses:ReorderReceiptRuleSet",
  "ses:SetActiveReceiptRuleSet",
  "ses:SetReceiptRulePosition",
  "ses:UpdateReceiptRule",
  "ses:SetIdentityMailFromDomain",
  "ses:PutEmailIdentityMailFromAttributes",
  "ses:CreateIngressPoint",
  "ses:UpdateIngressPoint",
  "ses:CreateRuleSet",
  "ses:UpdateRuleSet",
  "ses:CreateTrafficPolicy",
  "ses:UpdateTrafficPolicy",
] as const;

/** IAM action matching: case-insensitive, `*` any run of characters, `?` one character. */
export function actionMatches(pattern: string, action: string): boolean {
  const source = pattern
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "i").test(action);
}

/** Receiving actions some pattern of `patterns` reaches. */
export function receivingCoveredBy(patterns: readonly string[]): string[] {
  return RECEIVING_ACTIONS.filter((action) => patterns.some((pattern) => actionMatches(pattern, action)));
}

export interface PolicyStatement {
  /** The resource (or document) that declares the statement. */
  readonly owner: string;
  readonly sid: string;
  readonly effect: "Allow" | "Deny";
  readonly actions: readonly string[];
  /** Present when the statement uses `NotAction`: it then covers everything not listed. */
  readonly notActions?: readonly string[];
  readonly conditional: boolean;
  readonly allResources: boolean;
}

export interface PolicySet {
  readonly name: string;
  /** Statements that grant (identity policies of the role, or a standalone policy). */
  readonly grants: readonly PolicyStatement[];
  /** Statements whose `Deny` also applies (the grants themselves and the permissions boundary). */
  readonly denies: readonly PolicyStatement[];
}

export interface UncoveredGrant {
  readonly set: string;
  readonly owner: string;
  readonly sid: string;
  readonly actions: readonly string[];
}

function reached(statement: PolicyStatement): string[] {
  if (statement.notActions) {
    const excluded = new Set(receivingCoveredBy(statement.notActions));
    return RECEIVING_ACTIONS.filter((action) => !excluded.has(action));
  }
  return receivingCoveredBy(statement.actions);
}

/** Allow statements of a set that reach a receiving action no unconditional `Deny` of the set covers. */
export function uncoveredGrants(set: PolicySet): UncoveredGrant[] {
  const denied = new Set(set.denies.filter((statement) => statement.effect === "Deny" && !statement.conditional && statement.allResources).flatMap(reached));
  return set.grants
    .filter((statement) => statement.effect === "Allow")
    .map((statement) => ({ set: set.name, owner: statement.owner, sid: statement.sid, actions: reached(statement).filter((action) => !denied.has(action)) }))
    .filter((grant) => grant.actions.length > 0);
}

// ---- CloudFormation templates --------------------------------------------------------------------

const INTRINSIC_NAMES = ["Base64", "Cidr", "Condition", "Equals", "FindInMap", "GetAtt", "GetAZs", "If", "ImportValue", "Join", "Not", "Or", "And", "Ref", "Select", "Split", "Sub"];

// Each `!Name` tag becomes `{ Name: value }` whatever node it tags, so the document parses as JSON.
const customTags = INTRINSIC_NAMES.flatMap((name) =>
  (["scalar", "seq", "map"] as const).map((kind) => ({
    tag: `!${name}`,
    ...(kind === "scalar" ? {} : { collection: kind }),
    resolve: (value: unknown) => ({ [name]: typeof value === "object" && value !== null && "toJSON" in value ? (value as { toJSON(): unknown }).toJSON() : value }),
  })),
);

type Node = Record<string, unknown>;

const asList = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

function actionText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isNode(value) && typeof value.Sub === "string") return value.Sub;
  return undefined;
}

function statementsOf(document: unknown, owner: string): PolicyStatement[] {
  if (!isNode(document)) return [];
  return asList(document.Statement)
    .filter(isNode)
    .map((raw, index) => ({
      owner,
      sid: typeof raw.Sid === "string" ? raw.Sid : `${owner}#${index + 1}`,
      effect: raw.Effect === "Deny" ? "Deny" : "Allow",
      actions: asList(raw.Action).map(actionText).filter((text): text is string => text !== undefined),
      ...(raw.NotAction !== undefined ? { notActions: asList(raw.NotAction).map(actionText).filter((text): text is string => text !== undefined) } : {}),
      conditional: raw.Condition !== undefined,
      allResources: raw.NotResource === undefined && asList(raw.Resource).some((resource) => resource === "*"),
    }));
}

const refName = (value: unknown): string | undefined => (isNode(value) && typeof value.Ref === "string" ? value.Ref : undefined);

/** The policy sets of a template: one per role, plus each policy no role of the template attaches. */
export function templatePolicySets(yaml: string): PolicySet[] {
  const document = parse(yaml, { customTags }) as unknown;
  const resources = isNode(document) && isNode(document.Resources) ? document.Resources : {};
  const entries = Object.entries(resources).filter((entry): entry is [string, Node] => isNode(entry[1]));
  const policies = new Map(
    entries
      .filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy" || resource.Type === "AWS::IAM::Policy")
      .map(([name, resource]) => [name, { statements: statementsOf(isNode(resource.Properties) ? resource.Properties.PolicyDocument : undefined, name), roles: asList(isNode(resource.Properties) ? resource.Properties.Roles : undefined).map(refName) }]),
  );
  const attached = new Set<string>();
  const sets: PolicySet[] = [];
  for (const [name, resource] of entries.filter(([, candidate]) => candidate.Type === "AWS::IAM::Role")) {
    const properties = isNode(resource.Properties) ? resource.Properties : {};
    const inline = asList(properties.Policies).filter(isNode).flatMap((policy) => statementsOf(policy.PolicyDocument, name));
    const managedNames = [...asList(properties.ManagedPolicyArns).map(refName), ...[...policies].filter(([, policy]) => policy.roles.includes(name)).map(([policyName]) => policyName)];
    const managed = managedNames.flatMap((policyName) => (policyName ? (attached.add(policyName), policies.get(policyName)?.statements ?? []) : []));
    const boundaryName = refName(properties.PermissionsBoundary);
    const boundary = boundaryName ? (policies.get(boundaryName)?.statements ?? []) : [];
    const grants = [...inline, ...managed];
    sets.push({ name, grants, denies: [...grants, ...boundary] });
  }
  for (const [name, policy] of policies) if (!attached.has(name)) sets.push({ name, grants: policy.statements, denies: policy.statements });
  return sets;
}
