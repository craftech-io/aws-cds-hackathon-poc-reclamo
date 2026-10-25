// CI guard of ADR-0003: this app sends email and NEVER receives it. Another app of the shared
// account owns the single active SES receipt rule set of us-east-1, so declaring a receipt rule,
// a rule set, a receipt filter, a custom MAIL FROM (it needs an MX), a Mail Manager ingress or an
// MX record would break it. The guard fails the pipeline before any deploy when the code declares
// one of those resources, calls one of those APIs, or when an IAM policy set of a template reaches one
// of those actions (by name or by wildcard) without an unconditional Deny that covers it
// (scripts/lint/iam-receiving.ts). Runtime and infra code never grant a wildcard SES action at all.
//
//   npm run lint:no-ses-receiving
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIVING_ACTIONS, actionMatches, templatePolicySets, uncoveredGrants } from "./iam-receiving";
import { isTestFile, sourceFiles } from "./shared-walk";

export interface ReceivingFinding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/** Scanned roots: every place infra, runtime code or a pipeline step lives. */
export const ROOTS = ["sst.config.ts", "infra", "packages", "scripts", ".github"];

const SELF = /^scripts\/lint\/(no-ses-receiving|iam-receiving|shared-walk)\.ts$/;

// IAM actions of SES receiving, MAIL FROM and Mail Manager ingress named in code (IAM prefix `ses:`).
const RECEIVING_ACTION = /ses:(?:[A-Za-z*]*Receipt(?:Rule|Filter)[A-Za-z*]*|[A-Za-z*]*MailFrom[A-Za-z*]*|[A-Za-z*]*IngressPoint[A-Za-z*]*|(?:Create|Update)RuleSet|[A-Za-z*]*TrafficPolicy[A-Za-z*]*)/;

// The value of an `actions:` / `Action:` key on one line, and the wildcard literals inside it
// (`"ses:*"`, `"ses:Create*"`, `"*"`).
const ACTION_LIST = /\bactions?\s*:\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/gi;
const WILDCARD_ACTION = /["'`]((?:ses:)?[A-Za-z?]*\*[A-Za-z*?]*)["'`]/g;

const CODE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:aws|awsnative)\.ses\.(?:Receipt\w*|ActiveReceiptRuleSet|MailFrom|MailManager\w*)\b/, "SES receiving resource"],
  [/\b(?:aws|awsnative)\.sesv2\.\w*MailFrom\w*\b/, "custom MAIL FROM resource"],
  [/\b(?:aws|awsnative)\.(?:ses|sesv2|mailmanager)\.\w*(?:Ingress|MailManager|TrafficPolicy)\w*\b/, "Mail Manager ingress resource"],
  [/\b(?:type|recordType)\s*:\s*["'`]mx["'`]/i, "MX record"],
  [/\bRecordType\.MX\b/, "MX record"],
  [/\b(?:Create|Delete|Update|Set|Clone|Reorder|Describe)\w*Receipt\w*Command\b/, "SES receiving API call"],
  [/\b(?:SetIdentityMailFromDomain|PutEmailIdentityMailFromAttributes|CreateIngressPoint)Command\b/, "MAIL FROM or ingress API call"],
  [/["'`]@aws-sdk\/client-ses["'`]/, "SES v1 client (receiving and MAIL FROM live there; this app sends through sesv2)"],
];

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

// Code never needs a wildcard SES action; a wildcard that reaches receiving is refused outright.
function wildcardHit(text: string): string | undefined {
  for (const [, list] of text.matchAll(ACTION_LIST)) {
    for (const [, pattern] of (list ?? "").matchAll(WILDCARD_ACTION)) {
      if (pattern !== undefined && RECEIVING_ACTIONS.some((action) => actionMatches(pattern, action))) return `wildcard action ${pattern} reaches SES receiving`;
    }
  }
  return undefined;
}

/** Declarations and calls in TypeScript source; comment lines are ignored. */
export function findInCode(file: string, source: string): ReceivingFinding[] {
  const findings: ReceivingFinding[] = [];
  source.split("\n").forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    // One finding per line: the first pattern that matches names it.
    const hit = CODE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? (RECEIVING_ACTION.test(text) ? "SES receiving IAM action" : wildcardHit(text));
    if (hit) findings.push({ file, line: index + 1, what: hit });
  });
  return findings;
}

// The statement's line, searched from the resource that declares it (a role's grant may live in an
// attached policy).
function lineOfSid(yaml: string, owner: string, sid: string): number {
  const from = Math.max(yaml.search(new RegExp(`^\\s*${owner}:\\s*$`, "m")), 0);
  const at = yaml.indexOf(`Sid: ${sid}`, from);
  return lineOf(yaml, at >= 0 ? at : from);
}

/**
 * IAM grants of a CloudFormation template that reach a receiving action (by name, by wildcard or by
 * `NotAction`) without an unconditional Deny in the same role's policy set, and MX records.
 */
export function findAllowedInTemplate(file: string, yaml: string): ReceivingFinding[] {
  let sets: ReturnType<typeof templatePolicySets>;
  try {
    sets = templatePolicySets(yaml);
  } catch {
    return [{ file, line: 1, what: "template that cannot be parsed (the guard fails closed)" }];
  }
  const findings: ReceivingFinding[] = sets.flatMap(uncoveredGrants).map((grant) => ({
    file,
    line: lineOfSid(yaml, grant.owner, grant.sid),
    what: `${grant.set}/${grant.sid} allows ${grant.actions.join(", ")} without a Deny in the same policy set`,
  }));
  const mx = /Type:\s*AWS::Route53::RecordSet[\s\S]{0,400}?Type:\s*["']?mx["']?\s*$/im.exec(yaml);
  if (mx) findings.push({ file, line: lineOf(yaml, mx.index), what: "MX record" });
  return findings;
}

/** Workflow steps that touch SES receiving (the deploy has none: the rule set is not ours). */
export function findInWorkflow(file: string, yaml: string): ReceivingFinding[] {
  const findings: ReceivingFinding[] = [];
  yaml.split("\n").forEach((text, index) => {
    if (text.trim().startsWith("#")) return;
    if (/receipt-rule|receipt-filter|mail-from|ingress-point|\bMX\b/i.test(text)) findings.push({ file, line: index + 1, what: "SES receiving or MX step in a workflow" });
  });
  return findings;
}

export function scan(cwd: string): ReceivingFinding[] {
  const findings: ReceivingFinding[] = [];
  for (const file of sourceFiles(cwd, ROOTS)) {
    if (SELF.test(file) || isTestFile(file)) continue;
    const source = readFileSync(resolve(cwd, file), "utf8");
    if (file.startsWith(".github/")) findings.push(...findInWorkflow(file, source));
    else findings.push(...(/\.ya?ml$/.test(file) ? findAllowedInTemplate(file, source) : findInCode(file, source)));
  }
  return findings;
}

function main(): void {
  const findings = scan(process.cwd());
  if (findings.length > 0) {
    console.error(`no-ses-receiving: ${findings.length} finding(s); this app never receives email (ADR-0003):`);
    for (const { file, line, what } of findings) console.error(`  ${file}:${line}  ${what}`);
    process.exit(1);
  }
  console.log("no-ses-receiving: no receipt rule, rule set, filter, MAIL FROM, ingress or MX anywhere.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
