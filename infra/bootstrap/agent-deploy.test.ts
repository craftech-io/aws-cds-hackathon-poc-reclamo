// What the deploy role and the workflow need for the agent's resources (docs/architecture.md §15 and §16):
// the application inference profile of the agent model, and the push of changed Gateway tool schemas
// that runs right before `sst deploy`. Read as text, like ci-role.test.ts.
import { describe, expect, it } from "vitest";
import { block, deployWorkflow, statement, template } from "./template-text";

describe("the agent's deploy", () => {
  it("creates the agent's application inference profile only as the app", () => {
    expect(statement("CreateTaggedAsThisApp")).toContain("- bedrock:CreateInferenceProfile");
  });

  it("lists gateways account-wide only to find this app's by name; reads and updates of targets stay under the tag fence", () => {
    // scripts/agent/push-gateway-schemas.ts: ListGateways has no resource-level permission;
    // Get/UpdateGatewayTarget and ListGatewayTargets reach only the gateway tagged as the app.
    const unscoped = statement("NoResourceLevelDeploy");
    expect(unscoped.match(/- bedrock-agentcore:\w+/g)).toEqual(["- bedrock-agentcore:ListGateways"]);
    expect(unscoped).toContain("aws:RequestedRegion: !Ref Region");
    const tagged = block(template, 'ManagedPolicyName: !Sub "${AppName}-ci-deploy-app-resources"', "- Sid: CreateTaggedAsThisApp");
    expect(tagged).toContain("- bedrock-agentcore:*");
    expect(tagged).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("pushes the changed Gateway tool schemas with the deploy role, right before sst deploy", () => {
    const push = deployWorkflow.indexOf("npx tsx scripts/agent/push-gateway-schemas.ts --apply");
    const deploy = deployWorkflow.indexOf("npx sst deploy --stage poc");
    const assume = deployWorkflow.indexOf("role-session-name: github-deploy-");
    expect(push).toBeGreaterThan(assume);
    expect(push).toBeLessThan(deploy);
  });
});
