// The two simulated external systems, CoreMock and NetworkMock (docs/architecture-integrations.md §5
// and §6, docs/architecture.md §13 and §14), as plain data and pure functions: who calls them, the two
// sides of the permission an AWS_IAM Function URL needs, and the role ARNs the mocks authorise by
// (`MockCallers`). No SST or Pulumi dependency: infra/mocks.ts builds the resources from here and
// infra/mocks-spec.test.ts checks it without an account.

import { LAMBDA_CAPABILITIES, MOCK_CONDITIONS, resolveCapabilities, type CapabilityName, type LambdaName } from "./iam-capabilities";
import { fixedRoleArn, type PermissionStatement } from "./workers-spec";

export const MOCK_NAMES = ["CoreMock", "NetworkMock"] as const;
export type MockName = (typeof MOCK_NAMES)[number];

/** Capability that lets a Lambda call each mock (infra/iam-capabilities.ts). */
export const MOCK_CAPABILITY = { CoreMock: "MOCK_CORE", NetworkMock: "MOCK_NETWORK" } as const satisfies Record<MockName, CapabilityName>;

/**
 * Logical name of each mock's Function. The Linkable that callers read (`Resource.CoreMock.url`)
 * keeps the bare name, so the Function takes another one.
 */
export const MOCK_FUNCTION_NAMES = { CoreMock: "CoreMockApi", NetworkMock: "NetworkMockApi" } as const satisfies Record<MockName, string>;

export const FUNCTION_URL_AUTH_TYPE = "AWS_IAM";

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];

/** Mocks a Lambda calls, from its capabilities. */
export function mocksCalledBy(fn: LambdaName): MockName[] {
  const held = resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities);
  return MOCK_NAMES.filter((mock) => held.includes(MOCK_CAPABILITY[mock]));
}

/** Lambdas that call one mock (docs/architecture.md §14, "Políticas de recurso"). */
export function mockInvokers(mock: MockName): LambdaName[] {
  return LAMBDAS.filter((fn) => mocksCalledBy(fn).includes(mock)).sort();
}

/** Every Lambda that calls any mock: each runs under a fixed-name role (infra/workers-spec.ts). */
export function mockCallers(): LambdaName[] {
  return LAMBDAS.filter((fn) => mocksCalledBy(fn).length > 0).sort();
}

/**
 * `Resource.MockCallers.roles` of both mocks: the role ARN of every caller by logical name. The mocks
 * compare the session's `assumed-role/<name>` with these (core-mock/src/http/caller.ts,
 * network-mock/src/http/caller.ts) and authorise the `worldId` of the path per role.
 */
export function mockCallerRoles(scope: { readonly account: string; readonly app: string; readonly stage: string }): Record<string, string> {
  return Object.fromEntries(mockCallers().map((fn) => [fn, fixedRoleArn(scope, fn)]));
}

const CONDITION_TEST: Readonly<Record<string, string>> = {
  "lambda:FunctionUrlAuthType": "StringEquals",
  "lambda:InvokedViaFunctionUrl": "Bool",
};

/**
 * Identity side (capabilities MOCK_CORE / MOCK_NETWORK): `lambda:InvokeFunctionUrl` only for an
 * AWS_IAM URL and `lambda:InvokeFunction` only through the Function URL, never directly.
 */
export function mockInvokeStatements<R = string>(functionArn: R): Array<Omit<PermissionStatement, "resources"> & { readonly resources: R[] }> {
  return Object.entries(MOCK_CONDITIONS).map(([action, conditions]) => ({
    actions: [action],
    resources: [functionArn],
    conditions: Object.entries(conditions).map(([variable, value]) => {
      const test = CONDITION_TEST[variable];
      if (test === undefined) throw new Error(`No IAM operator is known for ${variable}.`);
      return { test, variable, values: [value] };
    }),
  }));
}

export interface ResourcePermissionSpec {
  readonly suffix: "Url" | "Invoke";
  readonly action: "lambda:InvokeFunctionUrl" | "lambda:InvokeFunction";
  readonly functionUrlAuthType?: typeof FUNCTION_URL_AUTH_TYPE;
  readonly invokedViaFunctionUrl?: true;
}

/**
 * Resource side: since October 2025 a Function URL with AWS_IAM needs both permissions in the mock's
 * resource policy too, one pair per calling role (principal = the role's ARN).
 */
export const MOCK_RESOURCE_PERMISSIONS: readonly ResourcePermissionSpec[] = [
  { suffix: "Url", action: "lambda:InvokeFunctionUrl", functionUrlAuthType: FUNCTION_URL_AUTH_TYPE },
  { suffix: "Invoke", action: "lambda:InvokeFunction", invokedViaFunctionUrl: true },
];
