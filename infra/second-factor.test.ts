// The SMS code's infrastructure (docs/architecture-guests.md §17): `sns:Publish` only for the Bff, on `*`
// (a phone number has no resource) with a deny on every topic, and the pass of a session that lives
// exactly as long as the console's session can.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SECOND_FACTOR_LIMITS } from "../packages/bff/src/leads/limits";
import { LAMBDA_CAPABILITIES, expectedActions, type LambdaName } from "./iam-capabilities";
import { SMS_PUBLISH_PERMISSIONS, SMS_TOPICS_ARN } from "./messaging-sms";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("the SMS code's IAM and session [FL-131]", () => {
  it("[FL-131] grants sns:Publish straight to a number and denies every topic", () => {
    expect(SMS_PUBLISH_PERMISSIONS).toEqual([
      { actions: ["sns:Publish"], resources: ["*"] },
      { effect: "deny", actions: ["sns:Publish"], resources: [SMS_TOPICS_ARN] },
    ]);
    expect(SMS_TOPICS_ARN).toBe("arn:aws:sns:*:*:*");
  });

  it("[FL-131] gives it to the Bff only: its capabilities and its Function, no other file of the infra", () => {
    const publishers = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => expectedActions(fn).includes("sns:Publish"));
    expect(publishers).toEqual(["Bff"]);
    const bff = read("infra/bff.ts");
    const bffFunction = bff.slice(bff.indexOf('new sst.aws.Function("Bff"'), bff.indexOf('new sst.aws.Function("QaDriver"'));
    expect(bffFunction).toContain("...SMS_PUBLISH_PERMISSIONS]");
    expect(bff.match(/SMS_PUBLISH_PERMISSIONS/g)).toHaveLength(2);
    const others = readdirSync(resolve(process.cwd(), "infra")).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !["messaging-sms.ts", "iam-capabilities.ts", "bff.ts"].includes(file));
    // A role grant (`actions: [... "sns:Publish" ...]`); the topics' resource policies for AWS services are not one.
    for (const file of others) expect(read(`infra/${file}`), file).not.toMatch(/actions:\s*\[[^\]]*"sns:Publish"|SMS_PUBLISH_PERMISSIONS/);
  });

  it("keeps the pass of a session as long as the console's session (TOKEN_VALIDITY.consoleRefreshHours)", () => {
    const hours = /consoleRefreshHours:\s*(\d+)/.exec(read("infra/auth.ts"))?.[1];
    expect(SECOND_FACTOR_LIMITS.sessionHours).toBe(Number(hours));
  });
});
