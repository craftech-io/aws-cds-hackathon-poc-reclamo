// Gateway tool schemas of the seven targets (docs/tool-catalog.md, docs/architecture.md §9.2). The single
// source is zod, in packages/bff/src/agent-tools/<target>/schema.ts; this module runs the same generator
// that `npm run tools:build-schemas` checks in CI (packages/bff/src/agent-tools/common/gateway-schema.ts),
// so what CI checks is what gets deployed. It creates no resource:
//
//   infra/agentcore.ts          passes `gatewayToolSchemas[target].inlinePayload` as the target's
//                               `toolSchema.inlinePayload` and puts `digest` in the target's description;
//   infra/policy.ts             validates every Cedar statement against `gatewayInlinePayloads` before
//                               attaching it (a cited field missing from these schemas fails the deploy);
//   infra/policy-rules.test.ts  checks the same thing without an account.
//
// A schema the Gateway cannot take (a word outside type/properties/required/items/description, a tool
// without schema, a target with a tool that is not its own) throws here, so the deploy stops before any
// GatewayTarget changes.
import { checkGatewayBuild } from "../packages/bff/src/agent-tools/common/build-schemas";
import { type GatewayToolDefinition, buildGatewayPayloads, payloadDigest } from "../packages/bff/src/agent-tools/common/gateway-schema";
import { ToolTarget } from "../packages/bff/src/agent-tools/common/targets";

export interface GatewayTargetSchema {
  /** `toolSchema.inlinePayload` of the target: one entry per tool, named without the target prefix. */
  readonly inlinePayload: GatewayToolDefinition[];
  /** First 16 hex characters of the SHA-256 of the payload. */
  readonly digest: string;
}

const build = buildGatewayPayloads();
const problems = checkGatewayBuild(build);
if (problems.length > 0) {
  throw new Error(`Gateway tool schemas cannot be deployed (run npm run tools:build-schemas): ${problems.join("; ")}`);
}

export const gatewayToolSchemas = Object.fromEntries(
  ToolTarget.options.map((target) => [target, { inlinePayload: build.payloads[target], digest: payloadDigest(build.payloads[target]) }]),
) as { readonly [T in ToolTarget]: GatewayTargetSchema };

/** The payloads alone, in the shape infra/policy.ts validates the Cedar statements against. */
export const gatewayInlinePayloads = build.payloads;
