// Guards of the CI bootstrap (infra/bootstrap/ci-role.yaml) and of the deploy workflow, read as text
// on purpose: each check is a line someone under pressure would be tempted to write, and must not.
import { describe, expect, it } from "vitest";
import { FIXED_NAMES, allows, block, deployWorkflow, parameterBlock, read, renderedManagedPolicies, statement, statements, template, withoutComments } from "./template-text";

const TRUSTS = {
  deploy: block(template, "  DeployRole:", "ManagedPolicyArns:"),
  "qa-runner": block(template, "  QaRunnerRole:", "      Policies:"),
};

describe.each(Object.entries(TRUSTS))("trust of the %s role", (_role, trust) => {
  it("matches the sub claim exactly, never with a wildcard", () => {
    expect(trust).toContain("StringEquals:");
    expect(trust).not.toMatch(/StringLike|ArnLike/);
    const subs = trust.split("\n").filter((line) => line.includes('"repo:'));
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub).toContain(":ref:refs/heads/${DeployBranch}");
      expect(sub).not.toContain("*");
    }
  });

  it("accepts the id-bearing sub of repositories created after 2026-07-15", () => {
    expect(trust).toContain("repo:${GitHubOrg}@${GitHubOrgId}/${GitHubRepo}@${GitHubRepoId}:ref:refs/heads/${DeployBranch}");
  });

  it("binds the workflow file on the deploy branch", () => {
    expect(trust).toContain("token.actions.githubusercontent.com:job_workflow_ref:");
    expect(trust).toContain('/.github/workflows/deploy.yml@refs/heads/${DeployBranch}"');
  });

  it("always binds the immutable repository and owner ids", () => {
    expect(trust).toContain("token.actions.githubusercontent.com:repository_id: !Ref GitHubRepoId");
    expect(trust).toContain("token.actions.githubusercontent.com:repository_owner_id: !Ref GitHubOrgId");
    expect(trust).not.toContain("AWS::NoValue");
  });
});

describe("repository parameters", () => {
  it.each(["GitHubOrgId", "GitHubRepoId"])("makes %s mandatory and numeric", (parameter) => {
    const definition = parameterBlock(parameter);
    expect(definition).toContain('AllowedPattern: "^[0-9]+$"');
    expect(definition).not.toMatch(/^\s*Default:/m);
  });
});

describe("deploy workflow", () => {
  it("declares no environment, which would change the sub claim the trust expects", () => {
    expect(deployWorkflow).not.toMatch(/^\s*environment:/m);
  });

  it("assumes the role through OIDC and never with access keys", () => {
    expect(deployWorkflow).toContain("id-token: write");
    expect(deployWorkflow).toContain("role-to-assume:");
    expect(deployWorkflow).not.toMatch(/aws-access-key-id|aws-secret-access-key|AWS_SECRET_ACCESS_KEY/);
  });
});

describe("permissions of the deploy role and of the boundary", () => {
  it("defaults to the names of this app, with the bucket prefix SST's truncation keeps", () => {
    expect("aws-cds-hackathon-poc-reclamo".slice(0, 25)).toBe("aws-cds-hackathon-poc-rec");
    const defaults = { AppName: "aws-cds-hackathon-poc-reclamo", BucketPrefix: "aws-cds-hackathon-poc-rec", DeployStage: "poc", AppDomain: "reclamo.demo.craftech.io", AgentNamePrefix: "aws_cds_hackathon_poc_reclamo", GitHubRepo: "aws-cds-hackathon-poc-reclamo" };
    for (const [name, value] of Object.entries(defaults)) expect(parameterBlock(name), name).toContain(`Default: ${value}`);
  });

  it("stays under the size CloudFormation accepts for an inline template body", () => {
    // `aws cloudformation deploy --template-file` needs an S3 bucket above 51,200 bytes; the
    // bootstrap must stay a single command with no prerequisites.
    expect(Buffer.byteLength(read("infra/bootstrap/ci-role.yaml"), "utf8")).toBeLessThan(51_200);
  });

  it("never opens the sst dev bridge: this app has no local stage", () => {
    expect(template).not.toContain("aws:PrincipalTag/sst:stage");
    expect(template).not.toContain("appsync:");
    const createRole = block(template, "Sid: IamCreateAppRolesWithBoundary", "- Sid: IamEditPoliciesOfBoundedAppRoles");
    expect(createRole).toContain("aws:RequestTag/sst:stage: !Ref DeployStage");
    expect(template).toContain("Sid: DenyRoleTagsOfOtherStages");
  });

  it("has no statement over every action", () => {
    expect(template).not.toMatch(/^\s*Action:\s*["']?\*["']?\s*$/m);
    expect(template).not.toMatch(/^\s*-\s*["']\*["']\s*$/m);
  });

  it("keeps the deploy role out of other projects' SST state", () => {
    expect(template).toContain("s3:::sst-state-*/*/${AppName}/*");
    expect(template).not.toMatch(/s3:::sst-state-\*\/\*"/);
  });

  it("fences IAM by the path of the app and forces the boundary on every new role", () => {
    const createRole = block(template, "Sid: IamCreateAppRolesWithBoundary", "- Sid: IamEditPoliciesOfBoundedAppRoles");
    expect(createRole).toContain("role/${AppName}/*");
    expect(createRole).toContain("iam:PermissionsBoundary: !Ref DeployBoundary");
    const outside = block(template, "Sid: DenyIamOutsideAppPath", "- Sid: DenyBoundaryRemovalOrSwap");
    expect(outside).toContain("NotResource:");
    for (const action of ["iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:AttachRolePolicy", "iam:PutRolePolicy", "sts:AssumeRole"]) expect(outside).toContain(action);
  });

  it("denies the administrative AWS managed policies", () => {
    const deny = block(template, "Sid: DenyAdministrativeManagedPolicies", "- Sid: DenyChangesToBootstrapResources");
    for (const policy of ["AdministratorAccess", "IAMFullAccess", "PowerUserAccess"]) expect(deny).toContain(`policy/${policy}`);
  });

  it("denies IAM management and role assumption to every role the app creates", () => {
    const boundary = block(template, "  DeployBoundary:", "  DeploySstHomePolicy:");
    const deny = block(boundary, "Sid: DenyIamManagementAndRoleAssumption", "- Sid: DenyPassingRolesOfOtherProjects");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("iam:Update*");
    expect(deny).toContain("sts:AssumeRole");
    expect(boundary).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("hands the Harness role the ECR Public bearer token and nothing else of STS", () => {
    const bearer = block(template, "Sid: HarnessImagePullBearerToken", "- Sid: HarnessRuntimeLogGroups");
    expect(bearer).toContain("sts:AWSServiceName: ecr-public.amazonaws.com");
    expect(template.split("\n").filter((line) => line.includes("sts:GetServiceBearerToken"))).toHaveLength(1);
  });

  it("creates SES identities and configuration sets only when the request tags them as the app", () => {
    const create = block(template, "Sid: CreateTaggedAsThisApp", "- Sid: NamedAppResources");
    expect(create).toContain("ses:CreateEmailIdentity");
    expect(create).toContain("ses:CreateConfigurationSet");
    // The Harness and Memory model goes through the app's tagged application inference profile (ADR-0021).
    expect(create).toContain("bedrock:CreateInferenceProfile");
    expect(create).toContain("aws:RequestTag/sst:app: !Ref AppName");
    expect(template).not.toMatch(/contact-list|ContactList|sms-voice|s3vectors|states:|transcribe|event-bus\//);
  });

  it("fences the runtime under the Harness by the name AgentCore gives it", () => {
    const runtime = block(template, "Sid: HarnessUnderlyingRuntime", "- Sid: AgentCoreUntaggableChildren");
    expect(runtime).toContain("runtime/harness_${AgentNamePrefix}*");
    expect(runtime).not.toMatch(/bedrock-agentcore:\*/);
  });
});

describe("tags as the fence", () => {
  it("never lets a request tag move a resource of another app into this one", () => {
    const create = statement("CreateTaggedAsThisApp");
    const tagActions = [...create.matchAll(/- ([\w-]+:(?:TagResource|TagQueue|AddTagsToCertificate))/g)].map((match) => match[1]);
    expect(tagActions.length).toBeGreaterThan(10);
    const deny = statement("DenyRetaggingOtherApps");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("aws:ResourceTag/sst:app: !Ref AppName");
    expect(block(deny, "StringNotEquals:", '"Null":')).toContain("aws:ResourceTag/sst:app");
    expect(deny).toContain('aws:ResourceTag/sst:app: "false"');
    for (const action of tagActions) expect(deny).toContain(`- ${action}`);
  });

  it("fences SNS topics and SQS queues by the app name, the only fence before they exist", () => {
    // The provider reads a named topic before creating it, so a tag condition can never pass there.
    const named = statement("TopicsAndQueuesOfThisApp");
    expect(named).toContain('sns:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(named).toContain('sqs:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(named).toContain('sns:${Region}:${AWS::AccountId}:${AppName}-wa-inbound"');
    expect(named).not.toMatch(/Resource: "\*"/);
    for (const action of ["sns:*", "sqs:*", "sns:Publish", "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:PurgeQueue"]) expect(named).not.toContain(`- ${action}\n`);
    expect(block(template, "ManagedPolicyArns:", "Tags:")).toContain("- !Ref DeployNamedResourcesPolicy");
  });

  it("reads log group tags account-wide but writes none of them outside the tag fence", () => {
    const reads = statement("LogGroupTagReads");
    expect(reads.match(/- logs:\w+/g)).toEqual(["- logs:ListTagsForResource", "- logs:ListTagsLogGroup"]);
  });

  it("grants the Cloud Control API under its real IAM prefix, limited to the region", () => {
    // `awsnative.*` resources go through Cloud Control, whose actions are `cloudformation:*Resource*`;
    // a `cloudcontrol:` action grants nothing and the deploy stops with AccessDenied.
    expect(template).not.toMatch(/-\s+cloudcontrol:/);
    const transport = statement("CloudControlTransport");
    for (const action of ["CreateResource", "GetResource", "UpdateResource", "DeleteResource", "GetResourceRequestStatus"]) expect(transport).toContain(`- cloudformation:${action}`);
    expect(transport).toContain("aws:RequestedRegion: !Ref Region");
    expect(transport).not.toContain("cloudformation:*");
    // The request log is account-wide: listing or cancelling would reach every project.
    for (const action of ["ListResources", "ListResourceRequests", "CancelResourceRequest"]) expect(transport).not.toContain(`cloudformation:${action}`);
  });

  it("keeps every managed policy under IAM's 6,144-character limit, rendered as IAM stores it", () => {
    const policies = renderedManagedPolicies();
    expect(Object.keys(policies).sort()).toEqual(["DeployAppResourcesPolicy", "DeployBoundary", "DeployDnsAndIamPolicy", "DeployEdgePolicy", "DeployNamedResourcesPolicy", "DeploySstHomePolicy"]);
    for (const [name, json] of Object.entries(policies)) expect(json.length, name).toBeLessThan(6_144);
  });
});

describe("email outbound only (ADR-0003) [FL-110]", () => {
  it("allows no receiving action anywhere and uses no sesv2: prefix", () => {
    for (const { sid, body } of allows) expect(body, sid).not.toMatch(/ReceiptRule|ReceiptFilter|MailFrom|IngressPoint|TrafficPolicy|ses:CreateRuleSet/);
    expect(template).not.toMatch(/sesv2:|receipt-rule-set|inbound-mail/);
  });

  it("denies receipt rules, filters, MAIL FROM and Mail Manager ingress explicitly", () => {
    const deny = statement("DenySesReceivingAndMailFrom");
    expect(deny).toContain("Effect: Deny");
    for (const action of ["ses:*ReceiptRule*", "ses:*ReceiptFilter*", "ses:SetIdentityMailFromDomain", "ses:PutEmailIdentityMailFromAttributes", "ses:CreateIngressPoint", "ses:CreateRuleSet", "ses:CreateTrafficPolicy", "ses:UpdateIngressPoint", "ses:UpdateRuleSet", "ses:UpdateTrafficPolicy"]) {
      expect(deny).toContain(`- ${action}`);
    }
  });

  it("denies receiving, Mail Manager ingress and MAIL FROM in the boundary too, whatever an app role allows", () => {
    const deny = statement("DenySesReceivingIngressAndMailFrom");
    expect(block(template, "  DeployBoundary:", "  DeploySstHomePolicy:")).toContain(deny);
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain('Resource: "*"');
    expect(deny).not.toContain("Condition:");
    for (const action of ["ses:*Receipt*", "ses:*RuleSet*", "ses:*IngressPoint*", "ses:*TrafficPolicy*", "ses:*MailFrom*"]) expect(deny).toContain(`- ${action}`);
  });

  it("changes DNS records only of this app, only of the allowed types, and never MX", () => {
    const records = statement("ProjectDnsRecords");
    expect(records).toContain("- !Ref AppDomain");
    expect(records).toContain('- !Sub "*.${AppDomain}"');
    expect(records).not.toMatch(/"\*\$\{AppDomain\}"|"\*demo\.craftech\.io"/);
    expect(records).toContain("route53:ChangeResourceRecordSetsRecordTypes: [A, AAAA, CNAME, TXT]");
    expect(records).toContain('route53:ChangeResourceRecordSetsNormalizedRecordNames: "false"');
    const mx = statement("DenyMxRecords");
    expect(mx).toContain("Effect: Deny");
    expect(mx).toContain("route53:ChangeResourceRecordSetsRecordTypes: MX");
  });

  it("denies a look-alike name of another demo of the shared zone", () => {
    const allowed = (name: string): boolean => ["reclamo.demo.craftech.io", "*.reclamo.demo.craftech.io"].some((glob) => new RegExp(`^${glob.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`).test(name));
    expect(["reclamo.demo.craftech.io", "_dmarc.reclamo.demo.craftech.io", "xreclamo.demo.craftech.io", "other.demo.craftech.io"].map(allowed)).toEqual([true, true, false, false]);
  });
});

describe("fixed names of docs/architecture.md §1", () => {
  const architecture = read("docs/architecture.md");

  it.each(FIXED_NAMES)("%s is in docs/architecture.md and covered by a statement with its exact ARN", (name, arn) => {
    expect(architecture).toContain(name);
    expect(statements.some(({ body }) => body.includes(arn)), arn).toBe(true);
  });

  it("names the three fixed-name buckets the browser reaches, and frames only blob:, in the CSP", () => {
    const csp = block(template, "ContentSecurityPolicy: !Sub", "Override: false");
    for (const purpose of ["media", "documents", "emails"]) {
      expect(architecture).toContain(`aws-cds-hackathon-poc-reclamo-poc-${purpose}-776805327629`);
      expect(csp).toContain(`https://\${AppName}-\${DeployStage}-${purpose}-\${AWS::AccountId}.s3.\${Region}.amazonaws.com`);
    }
    expect(csp).toContain("frame-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(template).toContain('Name: !Sub "${AppName}-${DeployStage}-console"');
    expect(template).toContain('Name: !Sub "${AppName}-${DeployStage}-router"');
  });
});

describe("GuardDuty Malware Protection for S3 over Media", () => {
  it("lets the deploy role manage only the plan tagged as the app and pass its role only to GuardDuty", () => {
    expect(statement("CreateTaggedAsThisApp")).toContain("guardduty:CreateMalwareProtectionPlan");
    const plan = statement("MalwarePlanOfThisApp");
    for (const verb of ["Update", "Delete", "Get"]) expect(plan).toContain(`guardduty:${verb}MalwareProtectionPlan`);
    for (const action of ["guardduty:TagResource", "guardduty:UntagResource"]) expect(plan).toContain(action);
    expect(plan).toContain("aws:ResourceTag/sst:app: !Ref AppName");
    expect(template).not.toContain("guardduty:*");
    for (const sid of ["PassMalwarePlanRole", "DenyPassingMalwarePlanRoleElsewhere"]) {
      expect(statement(sid)).toContain("iam:PassedToService: malware-protection-plan.guardduty.amazonaws.com");
    }
  });

  it("splits the managed rule statement of the boundary as the AWS template does", () => {
    const writes = statement("GuardDutyMalwareScanRule");
    for (const action of ["PutRule", "DeleteRule", "PutTargets", "RemoveTargets"]) expect(writes).toContain(`- events:${action}`);
    expect(writes).toContain("events:ManagedBy: malware-protection-plan.guardduty.amazonaws.com");
    const reads = statement("GuardDutyMalwareScanRuleReads");
    expect(reads).toContain("- events:DescribeRule");
    expect(reads).toContain("- events:ListTargetsByRule");
    expect(reads).not.toContain("Condition:");
    expect(writes).not.toMatch(/DescribeRule|ListTargetsByRule/);
    for (const body of [writes, reads]) expect(body).toContain("rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*");
  });

  it("puts the S3 actions of the plan's role and the validation object in the ceiling", () => {
    const media = statement("GuardDutyMalwareScanMedia");
    for (const action of ["PutObjectTagging", "GetObjectTagging", "PutObjectVersionTagging", "GetObjectVersionTagging", "PutBucketNotification", "GetBucketNotification", "ListBucket", "GetObject", "GetObjectVersion", "GetBucketLocation"]) {
      expect(media).toContain(`- s3:${action}`);
    }
    expect(media).not.toContain("s3:PutObject\n");
    const validation = statement("GuardDutyMalwareValidationObject");
    expect(validation).toContain("Action: s3:PutObject");
    expect(validation).toContain('media-${AWS::AccountId}/malware-protection-resource-validation-object"');
  });
});

describe("append-only register and anchors (ADR-0014)", () => {
  it("denies every role of the app updates, deletes and batch writes on the append-only tables", () => {
    const deny = statement("DenyRewritingAppendOnlyTables");
    for (const action of ["UpdateItem", "DeleteItem", "BatchWriteItem"]) expect(deny).toContain(`- dynamodb:${action}`);
    for (const table of ["Register", "ComplianceTape", "AuditLog"]) expect(deny).toContain(`table/*${table}*"`);
    expect(deny).not.toContain("dynamodb:PutItem");
  });

  it("keeps the anchor log group and lets only AnchorWriter and QaDriver write it", () => {
    const keep = statement("DenyRemovingAnchors");
    for (const action of ["DeleteLogGroup", "DeleteLogStream", "PutRetentionPolicy", "DeleteRetentionPolicy"]) expect(keep).toContain(`- logs:${action}`);
    const writes = statement("DenyAnchorWritesBesidesTheAnchorWriter");
    expect(writes).toContain("- logs:PutLogEvents");
    expect(writes).toContain("- logs:CreateLogStream");
    expect(writes).toContain("ArnNotLike:");
    // `role/*<name>` matches the role ARN with and without its IAM path.
    const principals = writes.split("\n").filter((line) => line.includes(":role/"));
    expect(principals.map((line) => line.trim().replace(/^.*:role\//, "").replace(/"$/, ""))).toEqual([
      "*${AppName}-${DeployStage}-anchor-writer",
      "*${AppName}-${DeployStage}-qa-driver",
    ]);
  });
});

describe("qa-runner", () => {
  const role = block(template, "  QaRunnerRole:", "Outputs:");

  it("only invokes the QA driver, reads the app's logs and metrics and simulates the app's roles", () => {
    const actions = [...role.matchAll(/Action: ([\w:-]+)/g)].map((match) => match[1]);
    expect([...new Set(actions)].sort()).toEqual(["cloudwatch:GetMetricData", "iam:SimulatePrincipalPolicy", "lambda:InvokeFunction", "logs:FilterLogEvents", "sts:AssumeRoleWithWebIdentity"]);
    expect(statement("InvokeTheQaDriverOnly")).toContain("function:${AppName}-${DeployStage}-qa-driver");
    expect(statement("ReadLogsOfThisApp")).toContain("aws:ResourceTag/sst:app: !Ref AppName");
    expect(statement("SimulateAppRoles")).toContain('role/${AppName}/*"');
  });

  it("trusts deploy.yml and scenarios.yml on main, nothing else", () => {
    const refs = role.split("\n").filter((line) => line.includes(".github/workflows/"));
    expect(refs).toHaveLength(2);
    expect(refs.join("\n")).toContain("deploy.yml@refs/heads/${DeployBranch}");
    expect(refs.join("\n")).toContain("scenarios.yml@refs/heads/${DeployBranch}");
  });
});

describe("other services of the app", () => {
  it("allows a public (NONE) Function URL only on the BFF", () => {
    const deny = statement("DenyPublicFunctionUrlsBesidesTheEdge");
    for (const action of ["lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig", "lambda:AddPermission"]) expect(deny).toContain(action);
    expect(deny).toContain("lambda:FunctionUrlAuthType: NONE");
    expect(deny).toContain('NotResource: !Sub "arn:${AWS::Partition}:lambda:${Region}:${AWS::AccountId}:function:${AppName}-${DeployStage}-BffFunction-*"');
  });

  it("manages only the project's budget, and sends WhatsApp only from this account's phone numbers", () => {
    expect(statement("ProjectBudget")).toContain('budget/${AppName}-*"');
    expect(statement("DenyBudgetsOfOtherProjects")).toContain('NotResource: !Sub "arn:${AWS::Partition}:budgets::${AWS::AccountId}:budget/${AppName}-*"');
    const whatsapp = statement("WhatsAppOfThisAccount");
    expect(whatsapp).toContain("social-messaging:SendWhatsAppMessage");
    expect(whatsapp).toContain('phone-number-id/*"');
    expect(whatsapp).not.toContain("social-messaging:*");
  });
});

describe("guest self-signup (docs/architecture-guests.md §12) [FL-110]", () => {
  const boundary = block(template, "  DeployBoundary:", "  DeploySstHomePolicy:");
  const edge = block(template, "  DeployEdgePolicy:", "  DeployDnsAndIamPolicy:");
  const wafAllows = allows.filter(({ body }) => body.includes("wafv2:"));

  it("fences wafv2 by the two fixed web ACL names; only ListWebACLs, justified, is account-wide", () => {
    const acls = statement("WebAclsOfThisApp");
    for (const action of ["CreateWebACL", "UpdateWebACL", "DeleteWebACL", "GetWebACL", "TagResource", "UntagResource", "ListTagsForResource"]) expect(acls).toContain(`- wafv2:${action}`);
    expect(acls).toContain('global/webacl/${AppName}-${DeployStage}-edge/*"');
    expect(acls).toContain('regional/webacl/${AppName}-${DeployStage}-auth/*"');
    expect(template).not.toMatch(/wafv2:\*|webacl\/\$\{AppName\}-\*/);
    // The one wildcard ACL ARN: GetWebACLForResource, a read IAM authorizes before the ACL is known.
    for (const { sid, body } of wafAllows) if (body.includes("webacl/*")) expect(sid).toBe("WafGetWebAclForResource");
    expect(statement("WafGetWebAclForResource")).toMatch(/Action: wafv2:GetWebACLForResource\n\s+Resource: !Sub "arn:\$\{AWS::Partition\}:wafv2:\$\{Region\}:\$\{AWS::AccountId\}:regional\/webacl\/\*\/\*"/);
    for (const { sid, body } of wafAllows) if (body.includes('Resource: "*"')) expect(sid).toBe("WafListWebAcls");
    expect(statement("WafListWebAcls")).toContain("Action: wafv2:ListWebACLs");
    expect(read("infra/bootstrap/ci-role.yaml")).toMatch(/# ListWebACLs has no resource-level permission[^\n]*\n\s+- Sid: WafListWebAcls/);
    expect(statement("WafManagedRuleSetReferences")).toContain(":*:regional/managedruleset/*");
    for (const { sid } of wafAllows) expect(edge, sid).toContain(`Sid: ${sid}`);
  });

  it("associates the Cognito ACL on the ACL and on the pool; the edge ACL only through UpdateDistribution", () => {
    const association = statement("CognitoWebAclAssociation");
    for (const action of ["AssociateWebACL", "DisassociateWebACL", "GetWebACLForResource", "ListResourcesForWebACL"]) expect(association).toContain(`- wafv2:${action}`);
    expect(association).toContain(":cognito-idp:${Region}:${AWS::AccountId}:userpool/*");
    expect(association).not.toContain("global/webacl");
    // CloudFront takes the ACL in its distribution config: cloudfront:* behind the tag plus GetWebACL.
    expect(block(template, "  DeployAppResourcesPolicy:", "  DeployNamedResourcesPolicy:")).toContain("- cloudfront:*");
    expect(statement("WebAclsOfThisApp")).toContain("- wafv2:GetWebACL");
    expect(wafAllows.filter(({ body }) => body.includes("AssociateWebACL")).map(({ sid }) => sid)).toEqual(["CognitoWebAclAssociation"]);
    // The pool's side of the association, its clients (secret included) and the triggers: cognito-idp behind the tag.
    expect(block(template, "  DeployAppResourcesPolicy:", "  DeployNamedResourcesPolicy:")).toContain("- cognito-idp:*");
    expect(withoutComments(template)).not.toMatch(/cognito-idp:GenerateSecret|cognito-idp:ClientSecret/);
    // WAF's call to Cognito carries no tags: the pool side by ARN, and a deny for pools tagged as another app.
    const poolSide = statement("CognitoPoolWebAclSide");
    for (const action of ["AssociateWebACL", "DisassociateWebACL", "GetWebACLForResource", "ListResourcesForWebACL"]) expect(poolSide).toContain(`- cognito-idp:${action}`);
    expect(poolSide).toContain(':cognito-idp:${Region}:${AWS::AccountId}:userpool/*"');
    expect(statement("DenyWebAclOnPoolsOfOtherProjects")).toMatch(/Effect: Deny[\s\S]*"Null":\n\s+aws:ResourceTag\/sst:app: "false"\n\s+StringNotEquals:\n\s+aws:ResourceTag\/sst:app: !Ref AppName/);
  });

  it("covers Leads, the edge key, the alert topic and Cognito's email role with the existing fences", () => {
    expect(block(template, "  DeployAppResourcesPolicy:", "  DeployNamedResourcesPolicy:")).toContain(":dynamodb:${Region}:${AWS::AccountId}:table/${AppName}-*");
    expect(statement("RouterKeyValueStoreOfThisApp")).toContain("Action: cloudfront-keyvaluestore:*");
    expect(statement("TopicsAndQueuesOfThisApp")).toContain(':sns:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(statement("IamServiceLinkedRoles")).toContain("role/aws-service-role/*");
  });

  it("lets LeadNotifier send only as the app identity and never lets a role delete a table", () => {
    const send = block(boundary, "Sid: SesSendAsThisApp", "- Sid: WhatsAppOfThisAccount");
    expect(send).toContain(":ses:${Region}:${AWS::AccountId}:identity/${AppDomain}");
    expect(boundary).toContain(":dynamodb:${Region}:${AWS::AccountId}:table/${AppName}-*");
    const deny = block(boundary, "Sid: DenyDeletingTables", "- Sid: DenyAccountOrganizationAndBilling");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("Action: dynamodb:DeleteTable");
    expect(deny).toContain('Resource: "*"');
  });
});
