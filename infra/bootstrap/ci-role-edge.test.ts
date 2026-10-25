// The CloudFront parts of the Router in the CI bootstrap: they carry no tags, so the deploy role
// reaches them by name and id only (infra/ci-spec.ts), never another project's in the shared account.
import { describe, expect, it } from "vitest";
import { allows, block, statement, template } from "./template-text";

const FUNCTION_FENCE = 'function/${AppName}-${DeployStage}-*"';
const KVS_FENCE = "!GetAtt RouterKeyValueStore.Arn";
const CACHE_POLICY_FENCE = 'cache-policy/${RouterCachePolicyId}"';

describe("CloudFront parts of the Router (no tags, shared account)", () => {
  it("grants cloudfront:* only behind the sst:app tag and the store data plane only on its ARN", () => {
    for (const { sid, body } of allows) {
      if (/cloudfront:\*/.test(body)) expect(body, sid).toContain("aws:ResourceTag/sst:app: !Ref AppName");
      if (body.includes("cloudfront-keyvaluestore:")) expect(body, sid).toContain(`Resource: ${KVS_FENCE}`);
    }
  });

  it("has no wildcard over the functions, stores or policies of the account", () => {
    expect(template).not.toMatch(
      /:cloudfront::\$\{AWS::AccountId\}:(function|key-value-store|cache-policy|origin-access-control|origin-request-policy|response-headers-policy)\/\*"/,
    );
  });

  it("updates, publishes and deletes only the functions named after this app", () => {
    for (const action of ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction"]) {
      for (const { sid, body } of allows.filter((candidate) => candidate.body.includes(action))) {
        expect(body, sid).toContain(`Resource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
      }
    }
    const deny = statement("DenyCloudFrontFunctionsOfOtherProjects");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain(`NotResource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
    for (const action of ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction"]) expect(deny).toContain(action);
  });

  it("writes routes only into the store the bootstrap creates, and never creates or deletes a store", () => {
    expect(block(template, "  RouterKeyValueStore:", "  DeployBoundary:")).toContain("Type: AWS::CloudFront::KeyValueStore");
    const deny = statement("DenyKeyValueStoresOfOtherProjects");
    expect(deny).toContain("Action: cloudfront-keyvaluestore:*");
    expect(deny).toContain(`NotResource: ${KVS_FENCE}`);
    const notOwned = statement("DenyCloudFrontPartsTheAppDoesNotOwn");
    for (const action of ["CreateKeyValueStore", "DeleteKeyValueStore", "UpdateKeyValueStore"]) {
      expect(notOwned).toContain(`cloudfront:${action}`);
      expect(allows.filter(({ body }) => body.includes(`cloudfront:${action}`))).toHaveLength(0);
    }
  });

  it("changes a cache policy only by the id the operator declares, none by default", () => {
    const parameter = block(template, "  RouterCachePolicyId:", "Conditions:");
    expect(parameter).toContain("Default: none");
    expect(parameter).toContain('AllowedPattern: "^(none|[0-9a-f]{8}-');
    for (const action of ["cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy"]) {
      for (const { sid, body } of allows.filter((candidate) => candidate.body.includes(action))) expect(body, sid).toContain(CACHE_POLICY_FENCE);
      expect(statement("DenyCachePoliciesOfOtherProjects")).toContain(action);
    }
    expect(statement("DenyCachePoliciesOfOtherProjects")).toContain(`NotResource: !Sub`);
  });

  it("never updates or deletes response headers, origin request policies or origin access controls", () => {
    const notOwned = statement("DenyCloudFrontPartsTheAppDoesNotOwn");
    for (const part of ["ResponseHeadersPolicy", "OriginRequestPolicy", "OriginAccessControl"]) {
      for (const verb of ["Update", "Delete"]) {
        expect(notOwned).toContain(`cloudfront:${verb}${part}`);
        expect(allows.filter(({ body }) => body.includes(`cloudfront:${verb}${part}`))).toHaveLength(0);
      }
    }
    expect(notOwned).toContain('Resource: "*"');
  });

  it("attaches the edge policy to the deploy role", () => {
    expect(block(template, "ManagedPolicyArns:", "Tags:")).toContain("- !Ref DeployEdgePolicy");
  });
});
