// The simulated external systems (docs/architecture-integrations.md §5 and §6, docs/architecture.md
// §4, §13 and §14, docs/build-plan.md WP-20), and the wiring every Lambda of WP-20 shares.
//
//   CoreMockApi      the lender's core (packages/core-mock), its own table `Core`, secret PhoneHashKey
//   NetworkMockApi   collection and transfer networks (packages/network-mock), table `Networks`, bucket
//                    `Settlements` (it writes the settlement CSVs)
//
// Both answer only on a Function URL with AWS_IAM (SigV4), no CORS: no browser and no anonymous caller
// reaches them, and nobody invokes them directly (ScheduleDispatch publishes through the URL too).
// Since October 2025 such a URL needs two permissions on each side, and every caller gets both:
//
//   identity   the Linkable `CoreMock` / `NetworkMock` (`Resource.CoreMock.url`) includes
//              `lambda:InvokeFunctionUrl` with `lambda:FunctionUrlAuthType = AWS_IAM` and
//              `lambda:InvokeFunction` with `lambda:InvokedViaFunctionUrl = true`, on that function only.
//              `functionData(fn)` links it to every holder of MOCK_CORE / MOCK_NETWORK.
//   resource   one pair of `aws.lambda.Permission` per calling role (principal = the role's ARN):
//              `grantMockInvoke(fn, created)`, called by the module that creates the caller.
//
// Second fence, per world class: each mock reads the caller's role from
// `requestContext.authorizer.iam.userArn` and compares it with `MockCallers.roles` (the role ARN of
// every caller, docs/architecture.md §14 "Autorización por mundo en los mocks"). Those ARNs must be
// known without creating the roles (a caller's policy names the mock, so the mock cannot depend on the
// caller), hence every caller runs under a FIXED role name `<app>-<stage>-<kebab>`
// (infra/workers-spec.ts `fixedRoleName`, applied with `fixedRole(fn)`): WP-20 applies it to its
// callers, infra/agent-tools.ts (WP-31) to the five tool targets and infra/bff.ts (WP-37) to the Bff
// and the QaDriver. A caller without its fixed name gets 403 CALLER_NOT_ALLOWED from the mock.
//
// `functionData(fn)` is the shared wiring of a Lambda from its entry of infra/iam-capabilities.ts:
// table, bucket and anchor access (never by SST's default link, infra/storage.ts), its secrets and
// the mocks it calls. infra/messaging-whatsapp.ts and infra/workers.ts build every Lambda with it.
//
// Cost: per request; nothing bills while no mock is called.
//
// Verify (reads only):
//   aws --profile craftech-demos lambda get-function-url-config --function-name <CoreMockApi name>   → AuthType AWS_IAM, no Cors
//   aws --profile craftech-demos lambda get-policy --function-name <CoreMockApi name>
//     → per calling role: InvokeFunctionUrl (lambda:FunctionUrlAuthType AWS_IAM) and InvokeFunction (lambda:InvokedViaFunctionUrl true)
//   aws --profile craftech-demos iam list-roles --path-prefix /aws-cds-hackathon-poc-reclamo/ --query 'Roles[].RoleName'
//     → …-poc-event-worker, …-poc-inbound-whatsapp, … (the names of MockCallers)

import { LAMBDA_CAPABILITIES, type LambdaCapabilities, type LambdaName, type SecretName } from "./iam-capabilities";
import { FUNCTION_URL_AUTH_TYPE, MOCK_FUNCTION_NAMES, MOCK_RESOURCE_PERMISSIONS, mockCallerRoles, mockInvokeStatements, mocksCalledBy, type MockName } from "./mocks-spec";
import * as secretModule from "./secrets";
import { RegisterAnchors, anchorAccess, bucketAccess, buckets, tables, tablesAccess, type StoragePermission } from "./storage";
import { FUNCTION_BUDGETS, HANDLERS, dataPlan, fixedRoleName, groupTableGrants } from "./workers-spec";

const SECRETS: Readonly<Record<SecretName, sst.Secret>> = secretModule;

export interface FunctionData {
  readonly links: unknown[];
  readonly permissions: StoragePermission[];
}

/** `transform.role` that pins a Lambda's role to `<app>-<stage>-<kebab>` (path and boundary: infra/ci.ts). */
export function fixedRole(fn: LambdaName): (args: aws.iam.RoleArgs) => undefined {
  return (args) => {
    args.name = fixedRoleName($app.name, $app.stage, fn);
    return undefined;
  };
}

const accountId = aws.getCallerIdentityOutput({}).accountId;

/** `Resource.MockCallers.roles`: the role ARN of every Lambda that may call a mock, by logical name. */
export const MockCallers = new sst.Linkable("MockCallers", {
  properties: { roles: accountId.apply((account) => mockCallerRoles({ account, app: $app.name, stage: $app.stage })) },
});

function dataOf(fn: LambdaName): FunctionData {
  const plan = dataPlan(fn);
  const entry: LambdaCapabilities = LAMBDA_CAPABILITIES[fn];
  const anchors = entry.anchors;
  return {
    links: [
      ...new Set<unknown>([...plan.tables.map((grant) => tables[grant.table]), ...plan.buckets.map((grant) => buckets[grant.bucket])]),
      ...plan.secrets.map((name) => SECRETS[name]),
      ...(anchors === undefined ? [] : [RegisterAnchors]),
    ],
    permissions: [
      ...groupTableGrants(plan.tables).map((group) => tablesAccess(group.tables, group.access, group.leadingKeys)),
      ...plan.buckets.map((grant) => bucketAccess(grant.bucket, grant.access, grant.prefixes)),
      ...(anchors === undefined ? [] : anchorAccess(anchors)),
    ],
  };
}

function mockFunction(mock: MockName, description: string): sst.aws.Function {
  const data = dataOf(mock);
  const budget = FUNCTION_BUDGETS[mock];
  return new sst.aws.Function(MOCK_FUNCTION_NAMES[mock], {
    description,
    handler: HANDLERS[mock],
    url: { authorization: "iam", cors: false },
    timeout: `${budget.timeoutSeconds} seconds`,
    memory: `${budget.memoryMb} MB`,
    link: [...data.links, MockCallers],
    permissions: data.permissions,
  });
}

export const coreMock = mockFunction("CoreMock", "Lender core (simulated external system): Function URL with AWS_IAM, callers authorised per world class.");
export const networkMock = mockFunction("NetworkMock", "Collection and transfer networks (simulated external system): Function URL with AWS_IAM.");

export const mockFunctions: Readonly<Record<MockName, sst.aws.Function>> = { CoreMock: coreMock, NetworkMock: networkMock };

/** `url` for the signed calls; `name` only so the QaDriver can show a direct invocation is refused (AccessDenied). */
function mockLinkable(mock: MockName): sst.Linkable<{ url: $util.Output<string>; name: $util.Output<string> }> {
  const target = mockFunctions[mock];
  return new sst.Linkable(mock, {
    properties: { url: target.url, name: target.name },
    include: mockInvokeStatements(target.arn).map((statement) => sst.aws.permission(statement)),
  });
}

/** `Resource.CoreMock.url` plus both invoke permissions (capability MOCK_CORE). */
export const CoreMock = mockLinkable("CoreMock");
/** `Resource.NetworkMock.url` plus both invoke permissions (capability MOCK_NETWORK). */
export const NetworkMock = mockLinkable("NetworkMock");

const MOCK_LINKABLES: Readonly<Record<MockName, unknown>> = { CoreMock, NetworkMock };

/**
 * Links and permissions of a Lambda from infra/iam-capabilities.ts: its tables, buckets, anchors and
 * secrets, and the Linkables of the mocks it calls (pair it with `grantMockInvoke`).
 */
export function functionData(fn: LambdaName): FunctionData {
  const data = dataOf(fn);
  return { links: [...data.links, ...mocksCalledBy(fn).map((mock) => MOCK_LINKABLES[mock])], permissions: data.permissions };
}

/**
 * Resource-policy side of calling the mocks: for each mock `fn` calls, the pair of permissions with the
 * role of `created` as principal. Fails for a Lambda without MOCK_CORE or MOCK_NETWORK.
 *
 * Each permission waits for the caller's Lambda function, not only for its role: Lambda rejects a role
 * created seconds earlier as "The provided principal was invalid" until IAM propagates it, and creating
 * the function (which itself waits for the role to be assumable) gives that time. The dependency names
 * `nodes.function`: SST registers that resource inside an `apply`, so depending on the component alone
 * does not wait for it.
 */
export function grantMockInvoke(fn: LambdaName, created: sst.aws.Function): aws.lambda.Permission[] {
  const mocks = mocksCalledBy(fn);
  if (mocks.length === 0) throw new Error(`${fn} holds neither MOCK_CORE nor MOCK_NETWORK (infra/iam-capabilities.ts); it may not call a mock.`);
  return mocks.flatMap((mock) =>
    MOCK_RESOURCE_PERMISSIONS.map(
      (spec) =>
        new aws.lambda.Permission(`${mock}${spec.suffix}${fn}`, {
          action: spec.action,
          function: mockFunctions[mock].name,
          principal: created.nodes.role.arn,
          ...(spec.functionUrlAuthType === undefined ? {} : { functionUrlAuthType: FUNCTION_URL_AUTH_TYPE }),
          ...(spec.invokedViaFunctionUrl === undefined ? {} : { invokedViaFunctionUrl: spec.invokedViaFunctionUrl }),
        }, { dependsOn: [created.nodes.function] }),
    ),
  );
}
