// The CI bootstrap template and the deploy workflow as text, for ci-role.test.ts and
// its size budget. Most checks read the text on purpose: each one is a line
// someone under pressure would be tempted to write, and must not.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { parse, type Tags } from "yaml";

export const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
export const withoutComments = (yaml: string): string =>
  yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

export const template = withoutComments(read("infra/bootstrap/ci-role.yaml"));
export const deployWorkflow = withoutComments(read(".github/workflows/deploy.yml"));

export function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `marker "${startMarker}"`).toBeGreaterThanOrEqual(0);
  expect(end, `marker "${endMarker}"`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Lines of one entry of `Parameters:` (two-space key), up to the next entry. */
export function parameterBlock(name: string): string {
  const lines = template.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `parameter ${name}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return rest.slice(0, next === -1 ? undefined : next).join("\n");
}

export interface Statement {
  readonly sid: string;
  readonly body: string;
}

/** Every statement of every policy, as text from its `- Sid:` line up to the next statement or resource. */
export function statementsOf(source: string): Statement[] {
  const statements: Statement[] = [];
  let current: { sid: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current) statements.push({ sid: current.sid, body: current.lines.join("\n") });
    current = undefined;
  };
  for (const line of source.split("\n")) {
    const sid = /^\s*- Sid: (\w+)/.exec(line)?.[1];
    if (sid) {
      flush();
      current = { sid, lines: [line] };
    } else if (/^ {0,4}\S/.test(line)) {
      flush();
    } else {
      current?.lines.push(line);
    }
  }
  flush();
  return statements;
}

export const statements = statementsOf(template);
export const statement = (sid: string): string => {
  const found = statements.filter((candidate) => candidate.sid === sid);
  expect(found, `statement ${sid}`).toHaveLength(1);
  return found[0]?.body ?? "";
};
export const allows = statements.filter(({ body }) => body.includes("Effect: Allow"));


// ---- Rendered size of a managed policy ---------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const INTRINSICS = ["Sub", "Ref", "GetAtt", "If", "Equals"] as const;
const CFN_TAGS: Tags = INTRINSICS.flatMap((name) => [
  { tag: `!${name}`, resolve: (value: string) => ({ [name]: value }) },
  { tag: `!${name}`, collection: "seq" as const, resolve: (value: { toJSON(): unknown }) => ({ [name]: value.toJSON() }) },
]) as unknown as Tags;

// Values CloudFormation substitutes at deploy time, with realistic lengths: the demos account, the
// numeric GitHub ids and an opaque CloudFront id.
const PSEUDO: Record<string, string> = {
  "AWS::Partition": "aws",
  "AWS::AccountId": "776805327629",
  GitHubOrgId: "60447213",
  GitHubRepoId: "1234567890",
  DeployBoundary: "arn:aws:iam::776805327629:policy/aws-cds-hackathon-poc-reclamo-ci-boundary",
};

/** Every managed policy of the template rendered as IAM stores it (JSON without whitespace), by logical id. */
export function renderedManagedPolicies(): Record<string, string> {
  const document = parse(read("infra/bootstrap/ci-role.yaml"), { customTags: CFN_TAGS }) as {
    Parameters: Record<string, { Default?: string }>;
    Resources: Record<string, { Type: string; Properties: { PolicyDocument?: Json } }>;
  };
  const value = (name: string): string =>
    PSEUDO[name] ?? document.Parameters[name]?.Default ?? `arn:aws:cloudfront::776805327629:key-value-store/${"0".repeat(36)}`;
  const render = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(render);
    if (node === null || typeof node !== "object") return node;
    if (typeof node.Sub === "string") return node.Sub.replace(/\$\{([\w:]+)\}/g, (_match, name: string) => value(name));
    if (typeof node.Ref === "string") return value(node.Ref);
    if (node.GetAtt !== undefined) return value("GetAtt");
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, render(child)]));
  };
  return Object.fromEntries(
    Object.entries(document.Resources)
      .filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy")
      .map(([name, resource]) => [name, JSON.stringify(render(resource.Properties.PolicyDocument ?? null))]),
  );
}

// ---- Fixed names -------------------------------------------------------------------------------

// Every fixed name of docs/architecture.md §1 with the exact ARN (template form) a statement names.
const P = "arn:${AWS::Partition}:";
const REGIONAL = "${Region}:${AWS::AccountId}";
export const FIXED_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["aws-cds-hackathon-poc-reclamo-wa-inbound", `${P}sns:${REGIONAL}:\${AppName}-wa-inbound"`],
  ["aws-cds-hackathon-poc-reclamo-budget-alerts", `${P}sns:${REGIONAL}:\${AppName}-budget-alerts"`],
  ["aws-cds-hackathon-poc-reclamo-email-poc", `${P}ses:${REGIONAL}:configuration-set/\${AppName}-email-\${DeployStage}"`],
  ["aws-cds-hackathon-poc-reclamo-github-deploy", `${P}iam::\${AWS::AccountId}:role/\${AppName}-github-deploy"`],
  ["aws-cds-hackathon-poc-reclamo-qa-runner", `${P}iam::\${AWS::AccountId}:role/\${AppName}-qa-runner"`],
  ["aws-cds-hackathon-poc-reclamo-ci-boundary", `${P}iam::\${AWS::AccountId}:policy/\${AppName}-ci-boundary"`],
  ["/aws-cds-hackathon-poc-reclamo/", `${P}iam::\${AWS::AccountId}:role/\${AppName}/*"`],
  ["aws-cds-hackathon-poc-reclamo-poc-qa-driver", `${P}lambda:${REGIONAL}:function:\${AppName}-\${DeployStage}-qa-driver"`],
  ["aws-cds-hackathon-poc-reclamo-poc-schedules", `${P}scheduler:${REGIONAL}:schedule-group/\${AppName}-\${DeployStage}-schedules"`],
  ["/aws-cds-hackathon-poc-reclamo/poc/register-anchors", `${P}logs:${REGIONAL}:log-group:/\${AppName}/\${DeployStage}/register-anchors*"`],
  ["aws-cds-hackathon-poc-reclamo-poc-anchor-writer", `${P}iam::\${AWS::AccountId}:role/*\${AppName}-\${DeployStage}-anchor-writer"`],
  ["aws-cds-hackathon-poc-reclamo-poc-malware-plan", `${P}iam::\${AWS::AccountId}:role/\${AppName}/\${AppName}-\${DeployStage}-malware-plan"`],
  ["aws-cds-hackathon-poc-reclamo-poc-media-776805327629", `${P}s3:::\${AppName}-\${DeployStage}-media-\${AWS::AccountId}"`],
  ["aws-cds-hackathon-poc-reclamo-poc-edge", `${P}wafv2:${REGIONAL}:global/webacl/\${AppName}-\${DeployStage}-edge/*"`],
  ["aws-cds-hackathon-poc-reclamo-poc-auth", `${P}wafv2:${REGIONAL}:regional/webacl/\${AppName}-\${DeployStage}-auth/*"`],
];
