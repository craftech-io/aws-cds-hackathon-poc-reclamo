// The push of changed Gateway tool schemas that runs before `sst deploy` (docs/architecture.md §16): it
// finds the gateway by name, leaves a target whose description carries the payload's digest alone,
// pushes the others with `UpdateGatewayTarget` (never `metadataConfiguration`) and waits for READY; it
// does nothing before the first deploy created the gateway, leaves a target not created yet to the deploy,
// and only prints the plan without `--apply`.
import {
  BedrockAgentCoreControlClient,
  GetGatewayTargetCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  UpdateGatewayTargetCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import type { GatewayTargetSchema } from "../../infra/agent-tool-schemas";
import { gatewayName, gatewayTargetDescription } from "../../infra/agentcore-spec";
import { ToolTarget } from "../../packages/bff/src/agent-tools/common/targets";
import { APP, pushGatewaySchemas, type PushDeps } from "./push-gateway-schemas";

const control = mockClient(BedrockAgentCoreControlClient);
const GATEWAY = "gw-0123456789";
const LAMBDA = (target: string) => `arn:aws:lambda:us-east-1:000000000000:function:tool-${target}`;

const schemas = Object.fromEntries(
  ToolTarget.options.map((target) => [target, { inlinePayload: [{ name: `${target}_tool`, description: "A tool.", inputSchema: { type: "object", properties: {}, required: [] } }], digest: `digest-${target}` }]),
) as unknown as { readonly [T in ToolTarget]: GatewayTargetSchema };

const described = (target: ToolTarget, digest = `digest-${target}`) => gatewayTargetDescription(target, 1, digest);

function deps(overrides: Partial<PushDeps> = {}): PushDeps & { readonly lines: string[] } {
  const lines: string[] = [];
  return { client: new BedrockAgentCoreControlClient({ region: "us-east-1" }), schemas, apply: true, stage: "poc", log: (line) => lines.push(line), sleep: async () => undefined, now: () => 0, lines, ...overrides };
}

/** The gateway with every target live; `stale` targets carry an old digest. */
function liveGateway(stale: readonly ToolTarget[]): void {
  control.on(ListGatewaysCommand).resolves({ items: [{ gatewayId: "gw-other", name: "another-app-poc", status: "READY", authorizerType: "AWS_IAM", protocolType: "MCP", createdAt: new Date(0), updatedAt: new Date(0) }, { gatewayId: GATEWAY, name: gatewayName(APP, "poc"), status: "READY", authorizerType: "AWS_IAM", protocolType: "MCP", createdAt: new Date(0), updatedAt: new Date(0) }] });
  control.on(ListGatewayTargetsCommand).resolves({ items: ToolTarget.options.map((target) => ({ targetId: `tg-${target}`, name: target, status: "READY", createdAt: new Date(0), updatedAt: new Date(0) })) });
  for (const target of ToolTarget.options) {
    control
      .on(GetGatewayTargetCommand, { gatewayIdentifier: GATEWAY, targetId: `tg-${target}` })
      .resolves({
        gatewayArn: "arn",
        targetId: `tg-${target}`,
        name: target,
        status: "READY",
        description: stale.includes(target) ? described(target, "old-digest") : described(target),
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
        targetConfiguration: { mcp: { lambda: { lambdaArn: LAMBDA(target), toolSchema: { inlinePayload: [] } } } },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
  }
}

beforeEach(() => {
  control.reset();
});

describe("push-gateway-schemas", () => {
  it("does nothing before the first deploy created the gateway", async () => {
    control.on(ListGatewaysCommand).resolves({ items: [] });
    const run = deps();
    expect(await pushGatewaySchemas(run)).toEqual({ upToDate: [], changed: [], missing: [] });
    expect(control.commandCalls(ListGatewayTargetsCommand)).toHaveLength(0);
    expect(control.commandCalls(UpdateGatewayTargetCommand)).toHaveLength(0);
  });

  it("leaves the targets whose description carries the payload's digest and pushes only the changed one", async () => {
    const [stale] = ToolTarget.options;
    if (stale === undefined) throw new Error("no targets");
    liveGateway([stale]);
    const result = await pushGatewaySchemas(deps());
    expect(result.gateway).toBe(GATEWAY);
    expect(result.changed).toEqual([stale]);
    expect(result.upToDate).toHaveLength(ToolTarget.options.length - 1);
    const updates = control.commandCalls(UpdateGatewayTargetCommand).map((entry) => entry.args[0].input);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      gatewayIdentifier: GATEWAY,
      targetId: `tg-${stale}`,
      name: stale,
      description: described(stale),
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: { mcp: { lambda: { lambdaArn: LAMBDA(stale), toolSchema: { inlinePayload: schemas[stale].inlinePayload } } } },
    });
    expect(updates[0]).not.toHaveProperty("metadataConfiguration");
  });

  it("only prints the plan without --apply", async () => {
    liveGateway([...ToolTarget.options]);
    const run = deps({ apply: false });
    const result = await pushGatewaySchemas(run);
    expect(result.changed).toEqual([...ToolTarget.options]);
    expect(control.commandCalls(UpdateGatewayTargetCommand)).toHaveLength(0);
    expect(run.lines.at(-1)).toBe("push-gateway-schemas: run with --apply to push");
  });

  it("fails the step when a pushed target does not become READY, so sst deploy never runs over an old schema", async () => {
    const [stale] = ToolTarget.options;
    if (stale === undefined) throw new Error("no targets");
    liveGateway([stale]);
    control.on(UpdateGatewayTargetCommand).resolves({});
    control.on(GetGatewayTargetCommand, { gatewayIdentifier: GATEWAY, targetId: `tg-${stale}` }).resolvesOnce({ description: described(stale, "old-digest"), targetConfiguration: { mcp: { lambda: { lambdaArn: LAMBDA(stale), toolSchema: { inlinePayload: [] } } } } } as never).resolves({ status: "UPDATE_UNSUCCESSFUL" } as never);
    await expect(pushGatewaySchemas(deps())).rejects.toThrow(/did not become READY/);
  });

  it("leaves a target the gateway does not have yet to the deploy, so a deploy that failed halfway can still create it", async () => {
    const [absent, stale, ...rest] = ToolTarget.options;
    if (absent === undefined || stale === undefined) throw new Error("no targets");
    liveGateway([stale]);
    control.on(ListGatewayTargetsCommand).resolves({ items: [stale, ...rest].map((target) => ({ targetId: `tg-${target}`, name: target, status: "READY", createdAt: new Date(0), updatedAt: new Date(0) })) });
    control.on(UpdateGatewayTargetCommand).resolves({});
    const run = deps();
    const result = await pushGatewaySchemas(run);
    expect(result).toEqual({ gateway: GATEWAY, upToDate: rest, changed: [stale], missing: [absent] });
    expect(run.lines).toContain(`push-gateway-schemas: ${absent}: not created yet; the deploy creates it with its schema`);
    expect(control.commandCalls(UpdateGatewayTargetCommand).map((call) => call.args[0].input.name)).toEqual([stale]);
    expect(control.commandCalls(GetGatewayTargetCommand).some((call) => call.args[0].input.targetId === `tg-${absent}`)).toBe(false);
  });

  it("does nothing on a gateway with none of its targets yet", async () => {
    liveGateway([]);
    control.on(ListGatewayTargetsCommand).resolves({ items: [] });
    const result = await pushGatewaySchemas(deps());
    expect(result).toEqual({ gateway: GATEWAY, upToDate: [], changed: [], missing: [...ToolTarget.options] });
    expect(control.commandCalls(UpdateGatewayTargetCommand)).toHaveLength(0);
  });

  it("fails on a target that exists but has no Lambda configuration", async () => {
    const [stale] = ToolTarget.options;
    if (stale === undefined) throw new Error("no targets");
    liveGateway([]);
    control.on(GetGatewayTargetCommand, { gatewayIdentifier: GATEWAY, targetId: `tg-${stale}` }).resolves({ description: described(stale, "old-digest"), targetConfiguration: {} } as never);
    await expect(pushGatewaySchemas(deps())).rejects.toThrow(/has no Lambda target configuration/);
  });
});
