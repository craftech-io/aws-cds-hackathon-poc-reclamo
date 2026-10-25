// Pushes the Gateway tool schemas of the seven targets that changed (docs/architecture.md §16). Runs in
// deploy.yml right BEFORE `sst deploy`: the Cedar statements the deploy attaches are validated against the
// live schemas, so a new tool or field has to be on its target first. Also by hand, with the operator's
// profile, to see the plan (`--apply` is what writes).
//
// Why not Pulumi: every GatewayTarget ignores `targetConfiguration`, `metadataConfiguration` and
// `description` (infra/agentcore-spec.ts `gatewayTargetIgnoreChanges`). With the Cedar policy engine
// attached, AgentCore adds a restricted header to every target's `metadataConfiguration`, and a Cloud
// Control update sends it back and is refused; renaming a target changes every Cedar action id
// (`<target>___<tool>`), which infra/policy.ts refuses. `UpdateGatewayTarget` takes the target without
// `metadataConfiguration`, so this script carries a new schema the same way every time.
//
// Idempotent: a target whose live description already carries the digest of the generated payload
// (`gatewayTargetDescription`) is left as it is. The gateway is found by its name with `ListGateways`
// (`--gateway <id>` skips the lookup); a stage without a gateway yet does nothing, and neither does a
// target the gateway does not have yet (a deploy that failed halfway through the GatewayTarget chain):
// the deploy that runs next creates it with its schema, so this step never blocks the only way to
// create it. A target that exists but has no Lambda configuration, or does not become READY, fails.
//
//   npx tsx scripts/agent/push-gateway-schemas.ts [--stage poc] [--gateway <id>] [--apply]
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BedrockAgentCoreControlClient,
  GetGatewayTargetCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  type ToolDefinition,
  UpdateGatewayTargetCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { GatewayTargetSchema } from "../../infra/agent-tool-schemas";
import { gatewayName, gatewayTargetDescription } from "../../infra/agentcore-spec";
import { ToolTarget } from "../../packages/bff/src/agent-tools/common/targets";

export const APP = "aws-cds-hackathon-poc-reclamo";
const REGION = "us-east-1";
export const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 3_000;
const PAGE_SIZE = 50;

type ControlClient = Pick<BedrockAgentCoreControlClient, "send">;

export interface PushDeps {
  readonly client: ControlClient;
  readonly schemas: { readonly [T in ToolTarget]: GatewayTargetSchema };
  readonly apply: boolean;
  readonly stage: string;
  /** Skips the lookup by name. */
  readonly gatewayIdentifier?: string;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Real time in milliseconds: the deadline of a target becoming READY. */
  readonly now: () => number;
}

export interface PushResult {
  readonly gateway?: string;
  readonly upToDate: readonly ToolTarget[];
  /** Pushed with `apply`, or that would be pushed without it. */
  readonly changed: readonly ToolTarget[];
  /** Not on the gateway yet: left to the deploy, which creates them with their schemas. */
  readonly missing: readonly ToolTarget[];
}

/** The gateway of the stage, by its name; `undefined` before the first deploy created it. */
export async function findGateway(client: ControlClient, name: string): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListGatewaysCommand({ maxResults: PAGE_SIZE, ...(nextToken === undefined ? {} : { nextToken }) }));
    const found = (page.items ?? []).find((item) => item.name === name);
    if (found?.gatewayId !== undefined) return found.gatewayId;
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return undefined;
}

async function targetIds(client: ControlClient, gatewayIdentifier: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier, maxResults: PAGE_SIZE, ...(nextToken === undefined ? {} : { nextToken }) }));
    for (const item of page.items ?? []) if (item.name !== undefined && item.targetId !== undefined) ids.set(item.name, item.targetId);
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return ids;
}

async function waitReady(deps: PushDeps, gatewayIdentifier: string, targetId: string, target: ToolTarget): Promise<void> {
  const deadline = deps.now() + READY_TIMEOUT_MS;
  for (;;) {
    const { status } = await deps.client.send(new GetGatewayTargetCommand({ gatewayIdentifier, targetId }));
    if (status === "READY") return;
    if (status === "FAILED" || status === "UPDATE_UNSUCCESSFUL" || deps.now() > deadline) throw new Error(`${target} did not become READY (status ${status ?? "unknown"})`);
    await deps.sleep(READY_POLL_MS);
  }
}

export async function pushGatewaySchemas(deps: PushDeps): Promise<PushResult> {
  const gateway = deps.gatewayIdentifier ?? (await findGateway(deps.client, gatewayName(APP, deps.stage)));
  if (gateway === undefined) {
    deps.log("push-gateway-schemas: no gateway yet; the deploy creates the targets with their schemas");
    return { upToDate: [], changed: [], missing: [] };
  }
  const ids = await targetIds(deps.client, gateway);
  const upToDate: ToolTarget[] = [];
  const changed: ToolTarget[] = [];
  const missing: ToolTarget[] = [];
  for (const target of ToolTarget.options) {
    const targetId = ids.get(target);
    if (targetId === undefined) {
      missing.push(target);
      deps.log(`push-gateway-schemas: ${target}: not created yet; the deploy creates it with its schema`);
      continue;
    }
    const live = await deps.client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gateway, targetId }));
    const { inlinePayload, digest } = deps.schemas[target];
    const description = gatewayTargetDescription(target, inlinePayload.length, digest);
    if (live.description === description) {
      upToDate.push(target);
      deps.log(`push-gateway-schemas: ${target}: up to date (${digest})`);
      continue;
    }
    const lambdaArn = live.targetConfiguration?.mcp?.lambda?.lambdaArn;
    if (lambdaArn === undefined) throw new Error(`${target} has no Lambda target configuration`);
    changed.push(target);
    if (!deps.apply) {
      deps.log(`push-gateway-schemas: ${target}: would push ${inlinePayload.length} tools (${digest})`);
      continue;
    }
    await deps.client.send(
      new UpdateGatewayTargetCommand({
        gatewayIdentifier: gateway,
        targetId,
        name: target,
        description,
        credentialProviderConfigurations: live.credentialProviderConfigurations,
        targetConfiguration: { mcp: { lambda: { lambdaArn, toolSchema: { inlinePayload: inlinePayload as unknown as ToolDefinition[] } } } },
      }),
    );
    await waitReady(deps, gateway, targetId, target);
    deps.log(`push-gateway-schemas: ${target}: pushed ${inlinePayload.length} tools (${digest})`);
  }
  if (!deps.apply && changed.length > 0) deps.log("push-gateway-schemas: run with --apply to push");
  return { gateway, upToDate, changed, missing };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  // Imported here: building the payloads runs the generator, which the unit tests replace.
  const { gatewayToolSchemas } = await import("../../infra/agent-tool-schemas");
  const gatewayIdentifier = argValue("--gateway");
  await pushGatewaySchemas({
    client: new BedrockAgentCoreControlClient({ region: REGION }),
    schemas: gatewayToolSchemas,
    apply: process.argv.includes("--apply"),
    stage: argValue("--stage") ?? "poc",
    ...(gatewayIdentifier === undefined ? {} : { gatewayIdentifier }),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`push-gateway-schemas: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
