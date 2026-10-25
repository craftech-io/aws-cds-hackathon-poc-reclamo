// CoreMock and NetworkMock (docs/architecture-integrations.md §5-§6, docs/architecture.md §13-§14):
// who may call them per infra/iam-capabilities.ts and the document, the two sides of the AWS_IAM
// Function URL permission, and the role ARNs the mocks authorise by, checked against the mocks' own
// caller code. infra/mocks.ts is evaluated against recording stand-ins of the SST and Pulumi globals.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CoreCaller, callerDirectory } from "../packages/core-mock/src/http/caller";
import { CALLER_ROLES, callerRoleOf } from "../packages/network-mock/src/http/caller";
import { LAMBDA_CAPABILITIES, type LambdaName } from "./iam-capabilities";
import { MOCK_FUNCTION_NAMES, MOCK_RESOURCE_PERMISSIONS, mockCallerRoles, mockCallers, mockInvokeStatements, mockInvokers } from "./mocks-spec";
import { HANDLERS, fixedRoleName } from "./workers-spec";

const APP = "aws-cds-hackathon-poc-reclamo";
const ACCOUNT = "776805327629";
const SCOPE = { account: ACCOUNT, app: APP, stage: "poc" };
const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
const TARGETS = ["ToolIdentity", "ToolAccount", "ToolInvestigation", "ToolActions", "ToolComplaints", "ToolMessaging", "ToolHandoff"];

/** Lambdas listed after "Invocantes de `CoreMock`:" / "De `NetworkMock`:" in the resource-policy row of §14. */
function documentedInvokers(mock: string): string[] {
  const sentence = new RegExp(`(?:Invocantes de|De) \`${mock}\`: ([^.]+)\\.`).exec(architecture)?.[1] ?? "";
  const named = [...sentence.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1] ?? "");
  return [...named, ...(sentence.includes("7 targets") ? TARGETS : [])].sort();
}

const fake = vi.hoisted(() => {
  class Out<T = unknown> {
    readonly promise: Promise<T>;
    constructor(value: unknown) {
      this.promise = Promise.resolve(value).then((settled) => (settled instanceof Out ? settled.promise : settled)) as Promise<T>;
    }
    apply<U>(fn: (value: T) => U): Out<U> {
      return new Out<U>(this.promise.then(fn));
    }
  }
  const created: Array<{ kind: string; name: string; args: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
  function resource(kind: string) {
    return class {
      readonly arn: Out<string>;
      readonly name: Out<string>;
      readonly url: Out<string>;
      readonly nodes: { role: { arn: Out<string> }; function: Out<string> };
      constructor(logicalName: string, args: Record<string, unknown> = {}, opts?: Record<string, unknown>) {
        created.push({ kind, name: logicalName, args, ...(opts === undefined ? {} : { opts }) });
        this.arn = new Out(`arn:aws:lambda:us-east-1:776805327629:function:${logicalName}`);
        this.name = new Out(`${logicalName}-name`);
        this.url = new Out(`https://${logicalName.toLowerCase()}.lambda-url.us-east-1.on.aws/`);
        this.nodes = { role: { arn: new Out(`arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-reclamo/${logicalName}-role`) }, function: new Out(`${logicalName}-function`) };
      }
    };
  }
  const globals = {
    $app: { name: "aws-cds-hackathon-poc-reclamo", stage: "poc" },
    sst: { Linkable: resource("sst.Linkable"), aws: { Function: resource("sst.aws.Function"), permission: (statement: unknown) => statement } },
    aws: { getCallerIdentityOutput: () => ({ accountId: new Out("776805327629") }), lambda: { Permission: resource("aws.lambda.Permission") } },
  };
  return { Out, created, globals, Function: globals.sst.aws.Function };
});

vi.mock("./secrets", () => Object.fromEntries(["SessionKey", "SimEnvelopeKey", "QaSimEnvelopeKey", "PhoneHashKey", "RegisterChainKey", "WabaId", "WhatsAppPhoneNumberId", "SeedOverrides", "LeadNotifyEmail", "EdgeOriginKey"].map((name) => [name, { secret: name }])));
vi.mock("./storage", () => ({
  tables: new Proxy({}, { get: (_target, name) => ({ table: String(name) }) }),
  buckets: new Proxy({}, { get: (_target, name) => ({ bucket: String(name) }) }),
  RegisterAnchors: { link: "RegisterAnchors" },
  tableAccess: (table: string, access: string, leadingKeys?: readonly string[]) => ({ tables: [table], access, leadingKeys }),
  tablesAccess: (names: readonly string[], access: string, leadingKeys?: readonly string[]) => ({ tables: [...names], access, leadingKeys }),
  bucketAccess: (bucket: string, access: string, prefixes?: readonly string[]) => ({ bucket, access, prefixes }),
  anchorAccess: (access: string) => [{ anchors: access }],
}));

for (const [name, value] of Object.entries(fake.globals)) Reflect.set(globalThis, name, value);

let mocks: typeof import("./mocks");
beforeAll(async () => {
  mocks = await import("./mocks");
});

const created = (kind: string, name: string) => {
  const found = fake.created.filter((item) => item.kind === kind && item.name === name);
  expect(found, `${kind} ${name}`).toHaveLength(1);
  return found[0]?.args ?? {};
};

describe("who calls the mocks (docs/architecture.md §14)", () => {
  it("matches the resource-policy row of the document", () => {
    expect(mockInvokers("CoreMock")).toEqual(documentedInvokers("CoreMock"));
    expect(mockInvokers("NetworkMock")).toEqual(documentedInvokers("NetworkMock"));
    expect(documentedInvokers("CoreMock")).toHaveLength(14);
  });

  it("matches the callers each mock's own code authorises by world class", () => {
    expect(mockInvokers("CoreMock")).toEqual([...CoreCaller.options].sort());
    expect(mockInvokers("NetworkMock")).toEqual([...CALLER_ROLES].sort());
  });

  it("never lets a mock call a mock, nor the auditor reach the networks", () => {
    expect(mockCallers()).not.toContain("CoreMock");
    expect(mockCallers()).not.toContain("NetworkMock");
    expect(mockInvokers("NetworkMock")).not.toContain("PolicyAudit");
  });
});

describe("MockCallers: role ARNs the mocks resolve a session to", () => {
  const roles = mockCallerRoles(SCOPE);

  it("names every caller's role <app>-<stage>-<kebab>, within IAM's 64 characters, under the app's path", () => {
    for (const fn of Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]) expect(fixedRoleName(APP, "poc", fn).length, fn).toBeLessThanOrEqual(64);
    expect(roles.QaDriver).toBe(`arn:aws:iam::${ACCOUNT}:role/${APP}/${APP}-poc-qa-driver`);
    expect(roles.SignupEventWorker).toBe(`arn:aws:iam::${ACCOUNT}:role/${APP}/${APP}-poc-signup-event-worker`);
    expect(Object.keys(roles).sort()).toEqual(mockCallers());
  });

  it("resolves an assumed-role session of each caller in both mocks, and nobody else", () => {
    const directory = callerDirectory({ roles });
    const session = (fn: LambdaName) => `arn:aws:sts::${ACCOUNT}:assumed-role/${fixedRoleName(APP, "poc", fn)}/${fn}-session`;
    for (const fn of mockInvokers("CoreMock")) expect(directory.resolve(session(fn)), fn).toBe(fn);
    for (const fn of mockInvokers("NetworkMock")) expect(callerRoleOf(session(fn), { roles }), fn).toBe(fn);
    expect(directory.resolve(session("EmailEvents"))).toBeUndefined();
    expect(callerRoleOf(session("PolicyAudit"), { roles })).toBeUndefined();
    expect(directory.resolve(`arn:aws:sts::111122223333:assumed-role/${fixedRoleName(APP, "poc", "Bff")}/x`)).toBeUndefined();
  });
});

describe("the AWS_IAM Function URL permission, both sides", () => {
  it("grants lambda:InvokeFunction only through the Function URL", () => {
    const statements = mockInvokeStatements("arn:mock");
    expect(statements).toEqual([
      { actions: ["lambda:InvokeFunctionUrl"], resources: ["arn:mock"], conditions: [{ test: "StringEquals", variable: "lambda:FunctionUrlAuthType", values: ["AWS_IAM"] }] },
      { actions: ["lambda:InvokeFunction"], resources: ["arn:mock"], conditions: [{ test: "Bool", variable: "lambda:InvokedViaFunctionUrl", values: ["true"] }] },
    ]);
  });

  it("pairs InvokeFunctionUrl (AWS_IAM) and InvokeFunction (via URL) on the resource side", () => {
    expect(MOCK_RESOURCE_PERMISSIONS).toEqual([
      { suffix: "Url", action: "lambda:InvokeFunctionUrl", functionUrlAuthType: "AWS_IAM" },
      { suffix: "Invoke", action: "lambda:InvokeFunction", invokedViaFunctionUrl: true },
    ]);
  });
});

describe("infra/mocks.ts", () => {
  it("answers only on an AWS_IAM Function URL without CORS, with its own data and nothing else", () => {
    const core = created("sst.aws.Function", MOCK_FUNCTION_NAMES.CoreMock);
    expect(core).toMatchObject({ handler: HANDLERS.CoreMock, url: { authorization: "iam", cors: false } });
    expect(core.permissions).toEqual([{ tables: ["Core"], access: "write", leadingKeys: undefined }]);
    expect(core.link).toEqual([{ table: "Core" }, { secret: "PhoneHashKey" }, mocks.MockCallers]);
    const network = created("sst.aws.Function", MOCK_FUNCTION_NAMES.NetworkMock);
    expect(network).toMatchObject({ handler: HANDLERS.NetworkMock, url: { authorization: "iam", cors: false } });
    expect(network.permissions).toEqual([
      { tables: ["Networks"], access: "write", leadingKeys: undefined },
      { bucket: "Settlements", access: "write", prefixes: undefined },
    ]);
    expect(network.link).toEqual([{ table: "Networks" }, { bucket: "Settlements" }, mocks.MockCallers]);
  });

  it("links MockCallers with the computed role ARNs and each mock's url with both identity statements", async () => {
    const callers = created("sst.Linkable", "MockCallers") as { properties: { roles: InstanceType<typeof fake.Out> } };
    expect(await callers.properties.roles.promise).toEqual(mockCallerRoles(SCOPE));
    for (const mock of ["CoreMock", "NetworkMock"] as const) {
      const linkable = created("sst.Linkable", mock) as { properties: { url: unknown }; include: Array<{ actions: string[]; resources: unknown[] }> };
      expect(linkable.properties.url).toBe(mocks.mockFunctions[mock].url);
      expect(linkable.include.map((statement) => statement.actions[0])).toEqual(["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"]);
      for (const statement of linkable.include) expect(statement.resources).toEqual([mocks.mockFunctions[mock].arn]);
    }
  });

  it("gives a caller the Linkables of exactly the mocks it calls", () => {
    expect(mocks.functionData("InboundWhatsApp").links).toContain(mocks.CoreMock);
    expect(mocks.functionData("InboundWhatsApp").links).not.toContain(mocks.NetworkMock);
    expect(mocks.functionData("ScheduleDispatch").links).toContain(mocks.NetworkMock);
    expect(mocks.functionData("ScheduleDispatch").links).not.toContain(mocks.CoreMock);
    expect(mocks.functionData("EmailEvents").links).not.toContain(mocks.CoreMock);
  });

  it("grants the resource-side pair per mock to the caller's role, and refuses a Lambda without the capability", async () => {
    const caller = new fake.Function("EventWorker");
    const grants = mocks.grantMockInvoke("EventWorker", caller as unknown as sst.aws.Function);
    expect(grants).toHaveLength(4);
    for (const name of ["CoreMockUrlEventWorker", "CoreMockInvokeEventWorker", "NetworkMockUrlEventWorker", "NetworkMockInvokeEventWorker"]) {
      const args = created("aws.lambda.Permission", name);
      expect(args.principal).toBe(caller.nodes.role.arn);
      expect(fake.created.find((entry) => entry.kind === "aws.lambda.Permission" && entry.name === name)?.opts).toEqual({ dependsOn: [caller.nodes.function] });
      expect(args.function).toBe(mocks.mockFunctions[name.startsWith("Core") ? "CoreMock" : "NetworkMock"].name);
      if (name.includes("Url")) expect(args).toMatchObject({ action: "lambda:InvokeFunctionUrl", functionUrlAuthType: "AWS_IAM" });
      else expect(args).toMatchObject({ action: "lambda:InvokeFunction", invokedViaFunctionUrl: true });
    }
    expect(() => mocks.grantMockInvoke("EmailEvents", caller as unknown as sst.aws.Function)).toThrow(/neither MOCK_CORE nor MOCK_NETWORK/);
  });

  it("pins a caller's role name", () => {
    const args: { name?: unknown } = {};
    mocks.fixedRole("ToolInvestigation")(args as aws.iam.RoleArgs);
    expect(args.name).toBe(`${APP}-poc-tool-investigation`);
  });
});
