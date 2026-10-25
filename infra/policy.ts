// AgentCore Policy engine and its Cedar policies (docs/design-brief.md §8.6, docs/architecture.md §9.2
// and §16, docs/build-plan.md WP-31). The statements are plain data in infra/policy-rules.ts; this module
// only turns them into resources.
//
// Two halves, because the Gateway and the Harness role are created later, by infra/agentcore.ts:
//
//   1. The engine is created here. It depends on no Gateway; infra/agentcore.ts passes
//      `{ arn: policyEngineArn, mode: GATEWAY_POLICY_ENGINE_MODE }` as the Gateway's
//      `policyEngineConfiguration`.
//   2. The policies are scoped to the Gateway ARN and to the Harness execution role, so they are created by
//      `attachGatewayPolicies`, which infra/agentcore.ts calls after the last GatewayTarget of the chain:
//      the engine validates every statement against the tool schemas of the Gateway it protects. The call
//      checks those same schemas first (every cited field declared with its type, every read behind
//      `has`, every Gateway tool permitted) and fails the deploy with the list of problems instead of
//      letting the engine reject a policy halfway.
//
// Order: the seven permits first (CED-PERMIT-<TARGET>), then every forbid with `dependsOn` all of them.
// The kill switch (CED-KILL-SWITCH) is always there and off: it denies nothing until KILL_SWITCH_ACTIVE is
// true in infra/policy-rules.ts, and flipping it is an in-place update (only `name` and `policyEngineId`
// force a replacement). The first-line cut is `KILL#AGENT` at runtime.
//
// Cost: per authorization request; nothing bills while the agent is idle.
//
// Verify (AWS CLI ≥ 2.27, or the SDK v3 scripts, docs/architecture.md §16):
//   aws --profile craftech-demos bedrock-agentcore-control list-policy-engines
//   aws --profile craftech-demos bedrock-agentcore-control list-policies --policy-engine-id <id>
//     → 19 policies ACTIVE: reclamo_poc_CED_PERMIT_* ×7, reclamo_poc_CED_SESSION_* ×7, …_CED_WA_KIND_ALLOWLIST,
//       …_CED_ATTACHMENTS_ALLOWLIST, …_CED_NO_SELF_APPROVAL, …_CED_NO_CAP_OVERRIDE, …_CED_KILL_SWITCH
//   aws --profile craftech-demos bedrock-agentcore-control get-policy --policy-engine-id <id> --policy-id <CED_KILL_SWITCH id>
//     → the statement ends in `when { false }` (present and off)

import type { ToolTarget } from "../packages/bff/src/agent-tools/common/targets";
import {
  GATEWAY_TARGETS,
  assumedRoleEntityId,
  cedarPolicies,
  creationPlan,
  inputSchemasByAction,
  policyEngineName,
  schemaProblems,
  type CedarPolicyDefinition,
  type CedarPolicyInputs,
  type GatewayToolSchema,
} from "./policy-rules";
import { tagList } from "./tags";

/**
 * Cedar policy names are unique in the whole account and another app of the shared account already owns
 * names like CED_KILL_SWITCH: every policy of this app carries this prefix; rules and tests keep the bare
 * ids. `^[A-Za-z][A-Za-z0-9_]*$`, at most 48 characters with the longest id.
 */
export const CEDAR_NAME_PREFIX = "reclamo_poc_";

/** How the Gateway applies the engine. The POC enforces from the first deploy. */
export const GATEWAY_POLICY_ENGINE_MODE = "ENFORCE" as const;

export const policyEngine = new awsnative.bedrockagentcore.PolicyEngine("PolicyEngine", {
  name: policyEngineName($app.name, $app.stage),
  description: `Cedar fences (CED-*) of the ${$app.name} agent, stage ${$app.stage}: tool allowlist of the Harness role and static fences on tool arguments.`,
  tags: tagList(),
});

export const policyEngineArn = policyEngine.policyEngineArn;
export const policyEngineId = policyEngine.policyEngineId;

export interface AttachGatewayPoliciesArgs {
  readonly gatewayArn: $util.Input<string>;
  /** Name of the Harness execution role; Cedar identifies it as `arn:aws:sts::<account>:assumed-role/<name>`. */
  readonly harnessRoleName: $util.Input<string>;
  /** Names the `GatewayTarget`s were created with; must be exactly `GATEWAY_TARGETS`. */
  readonly targetNames: readonly string[];
  /** The `inlinePayload` of every target (infra/agent-tool-schemas.ts), the schemas the engine validates against. */
  readonly toolSchemas: Readonly<Record<ToolTarget, readonly GatewayToolSchema[]>>;
  /** The last `GatewayTarget` of the chain. */
  readonly dependsOn: $util.Resource[];
}

function assertTargetNames(names: readonly string[]): void {
  const missing = GATEWAY_TARGETS.filter((target) => !names.includes(target));
  const unknown = names.filter((name) => !(GATEWAY_TARGETS as readonly string[]).includes(name));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`GatewayTarget names must be the targets of infra/policy-rules.ts (Cedar action ids are "<target>___<tool>"). Missing: [${missing.join(", ")}]. Unknown: [${unknown.join(", ")}].`);
  }
}

/**
 * Creates the Cedar policies in this stage's engine: permits first, then every forbid depending on all of
 * them. Returns them in creation order, so the Harness can `dependsOn` them and never run a turn without
 * the fences in place.
 */
export function attachGatewayPolicies(args: AttachGatewayPoliciesArgs): awsnative.bedrockagentcore.Policy[] {
  assertTargetNames(args.targetNames);
  // The set of policies, their names and the fields they cite do not depend on the ARNs; only the rendered
  // statements do.
  const definitions = cedarPolicies({ gatewayArn: "<gateway>", harnessPrincipalId: "<harness>" });
  const problems = schemaProblems(definitions, inputSchemasByAction(args.toolSchemas));
  if (problems.length > 0) throw new Error(`Cedar policies do not match the Gateway tool schemas:\n  ${problems.join("\n  ")}`);

  const accountId = aws.getCallerIdentityOutput({}).accountId;
  const inputs: $util.Output<CedarPolicyInputs> = $util
    .all([args.gatewayArn, args.harnessRoleName, accountId])
    .apply(([gatewayArn, roleName, account]) => ({ gatewayArn, harnessPrincipalId: assumedRoleEntityId(account, roleName) }));

  const statementOf = (definition: CedarPolicyDefinition): $util.Output<string> =>
    inputs.apply((resolved) => {
      const rendered = cedarPolicies(resolved).find((candidate) => candidate.name === definition.name);
      if (rendered === undefined) throw new Error(`Cedar policy ${definition.name} disappeared while rendering.`);
      return rendered.statement;
    });

  const created = new Map<string, awsnative.bedrockagentcore.Policy>();
  for (const step of creationPlan(definitions)) {
    const after = step.after.map((name) => {
      const policy = created.get(name);
      if (policy === undefined) throw new Error(`Cedar policy ${step.definition.name} must follow ${name}, which was not created first.`);
      return policy;
    });
    created.set(
      step.definition.name,
      new awsnative.bedrockagentcore.Policy(
        `Policy${step.definition.name.replace(/_/g, "")}`,
        {
          policyEngineId,
          name: `${CEDAR_NAME_PREFIX}${step.definition.name}`,
          description: step.definition.description,
          enforcementMode: step.definition.enforcementMode,
          validationMode: step.definition.validationMode,
          definition: { cedar: { statement: statementOf(step.definition) } },
        },
        { dependsOn: [...args.dependsOn, ...after], parent: policyEngine },
      ),
    );
  }
  return [...created.values()];
}
