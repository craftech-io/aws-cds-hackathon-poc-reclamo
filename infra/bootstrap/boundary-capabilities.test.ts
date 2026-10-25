// The permissions boundary of every app role (infra/bootstrap/ci-role.yaml DeployBoundary) against what
// the roles are granted (infra/iam-capabilities.ts): an action the boundary never allows is an implicit
// deny at runtime, and nothing in a deploy would show it.
import { describe, expect, it } from "vitest";
import { LAMBDA_CAPABILITIES, expectedActions, stringLike, type LambdaName } from "../iam-capabilities";
import { read, renderedManagedPolicies } from "./template-text";

interface BoundaryStatement {
  readonly Sid: string;
  readonly Effect: "Allow" | "Deny";
  readonly Action?: string | string[];
  readonly Resource?: string | string[];
  readonly Condition?: unknown;
}

const boundary = JSON.parse(renderedManagedPolicies().DeployBoundary ?? "{}") as { Statement: BoundaryStatement[] };
const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const allows = boundary.Statement.filter((statement) => statement.Effect === "Allow");
const allowing = (action: string) => allows.filter((statement) => list(statement.Action).some((pattern) => stringLike(pattern, action)));

/**
 * Actions without resource types (Service Authorization Reference): IAM evaluates them on `*` with no
 * resource tag, so only a boundary statement on `*` without a condition can allow them.
 */
const NO_RESOURCE_TYPES = ["scheduler:ListSchedules"] as const;

describe("the boundary allows every action a role of the app is granted", () => {
  const granted = [...new Set((Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).flatMap((fn) => expectedActions(fn)))].sort();

  it("matches each capability action with an Allow statement of the boundary", () => {
    expect(granted.length).toBeGreaterThan(0);
    for (const action of granted) expect(allowing(action).map((statement) => statement.Sid), action).not.toEqual([]);
  });

  it("allows the actions without resource types on `*` with no condition (NoResourceLevelRuntime)", () => {
    for (const action of NO_RESOURCE_TYPES.filter((item) => granted.includes(item))) {
      const usable = allowing(action).filter((statement) => list(statement.Resource).includes("*") && statement.Condition === undefined);
      expect(usable.map((statement) => statement.Sid), action).toEqual(["NoResourceLevelRuntime"]);
    }
    expect(granted).toContain("scheduler:ListSchedules");
    expect(read("infra/bff.ts")).toContain('{ actions: ["scheduler:ListSchedules"], resources: ["*"] }');
  });
});
