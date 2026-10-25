// The AgentCore Gateway of an in-process world (docs/architecture.md §9.2, §16): what the Harness's tool
// call goes through before a target Lambda runs. The policies are the stage's own Cedar statements
// (infra/policy-rules.ts `cedarPolicies`), checked against the generated Gateway schemas when the
// gateway is built (`schemaProblems`, what infra/policy.ts does before attaching them) and evaluated on
// every call with the local evaluator: principal the Harness role, action `<target>___<tool>`,
// resource this Gateway, `context.input` the arguments as the model wrote them. An allowed call reaches
// the target's deployed entry (`handle`) with the context the Gateway gives it, so `LAM-CALLER`, the
// session token, the strict input and the `LAM-*` fences all run.
import type { ToolResponse } from "@reclamo/bff/agent-tools/common/context";
import { gatewayContext } from "@reclamo/bff/agent-tools/common/principal";
import { type GatewayToolName, gatewayActionOf, targetOf } from "@reclamo/bff/agent-tools/common/targets";
import { gatewayInlinePayloads } from "../../../infra/agent-tool-schemas";
import { type CedarPolicyDefinition, assumedRoleEntityId, cedarPolicies, evaluateCedar, inputSchemasByAction, schemaProblems } from "../../../infra/policy-rules";
import type { LocalTargets } from "./stage/targets";

const ACCOUNT = "776805327629";
export const LOCAL_GATEWAY_ARN = `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/aws-cds-hackathon-poc-reclamo-poc-local`;
/** The Harness execution role: the only principal a permit names. */
export const HARNESS_PRINCIPAL = assumedRoleEntityId(ACCOUNT, "aws-cds-hackathon-poc-reclamo-poc-harness");

export type GatewayAnswer =
  /** The target ran (its own refusals included: they are tool results, not Gateway errors). */
  | { readonly kind: "RESULT"; readonly response: ToolResponse }
  /** Cedar denied the call: the target never ran. */
  | { readonly kind: "DENIED"; readonly determining: readonly string[] }
  /** No Gateway tool has that name. */
  | { readonly kind: "UNKNOWN_TOOL" };

export interface GatewayRecord {
  readonly tool: string;
  readonly action?: string;
  readonly answer: GatewayAnswer;
}

export interface LocalGateway {
  readonly policies: readonly CedarPolicyDefinition[];
  /** Every call, in order, with what it answered. */
  readonly calls: GatewayRecord[];
  /** One `tools/call` of the Harness: `input` is the arguments exactly as the model wrote them. */
  call(tool: string, input: Readonly<Record<string, unknown>>, principal?: string): Promise<GatewayAnswer>;
}

export interface LocalGatewayOptions {
  readonly targets: LocalTargets;
  /** `KILL_SWITCH_ACTIVE` of infra/policy-rules.ts; off by default, as in the stage. */
  readonly killSwitchActive?: boolean;
}

export function createLocalGateway(options: LocalGatewayOptions): LocalGateway {
  const policies = cedarPolicies({ gatewayArn: LOCAL_GATEWAY_ARN, harnessPrincipalId: HARNESS_PRINCIPAL }, { killSwitchActive: options.killSwitchActive ?? false });
  const problems = schemaProblems(policies, inputSchemasByAction(gatewayInlinePayloads));
  if (problems.length > 0) throw new Error(`the Cedar policies do not validate against the Gateway schemas: ${problems.join("; ")}`);
  const calls: GatewayRecord[] = [];
  let requests = 0;
  return {
    policies,
    calls,
    async call(tool, input, principal = HARNESS_PRINCIPAL) {
      const target = targetOf(tool);
      if (target === undefined) {
        const answer: GatewayAnswer = { kind: "UNKNOWN_TOOL" };
        calls.push({ tool, answer });
        return answer;
      }
      const action = gatewayActionOf(target, tool as GatewayToolName);
      const decision = evaluateCedar(policies, { principal, action, resource: LOCAL_GATEWAY_ARN, input });
      if (decision.decision === "DENY") {
        const answer: GatewayAnswer = { kind: "DENIED", determining: decision.determining };
        calls.push({ tool, action, answer });
        return answer;
      }
      requests += 1;
      const response = await options.targets[target].handle(structuredClone(input), gatewayContext(action, `local-gateway-${requests}`));
      const answer: GatewayAnswer = { kind: "RESULT", response };
      calls.push({ tool, action, answer });
      return answer;
    },
  };
}
