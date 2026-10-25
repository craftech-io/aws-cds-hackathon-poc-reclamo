import { describe, expect, it, vi } from "vitest";
import { ToolError } from "@reclamo/shared";
import { testConnector } from "../connector/testing";
import { qaSignupEmail, type SignupService } from "../guests/signup";
import { cognitoRefusal } from "./cognito-refusal";
import { stageQaCognito } from "./stage-cognito";
import { RUN, key, qaKit } from "./testing";

vi.mock("../auth/config", () => ({ authConfig: () => ({ userPoolId: "us-east-1_pool", consoleClientId: "console", serverClientId: "server", region: "us-east-1" }) }));

const named = (name: string, message = "x") => Object.assign(new Error(message), { name });
const QA = { runId: RUN, key: "su1" };
const USERNAME = qaSignupEmail(QA);

function confirmingService(calls: string[]): SignupService {
  return {
    confirm: async () => (calls.push("confirm"), { status: "CONFIRMED", worldStatus: "REGISTERED", email: "never-returned" }),
  } as unknown as SignupService;
}

describe("cognitoRefusal", () => {
  it("answers every Cognito error with an explicit reason, never UNAVAILABLE without one", () => {
    expect(cognitoRefusal(named("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED"))).toMatchObject({ code: "CONFLICT", reason: "ALREADY_CONFIRMED" });
    expect(cognitoRefusal(named("NotAuthorizedException", "Incorrect username or password."))).toMatchObject({ code: "FORBIDDEN", reason: "COGNITO_NOT_AUTHORIZED" });
    expect(cognitoRefusal(named("UserNotConfirmedException"))).toMatchObject({ code: "FORBIDDEN", reason: "NOT_CONFIRMED" });
    expect(cognitoRefusal(named("UserNotFoundException"))).toMatchObject({ code: "NOT_FOUND", reason: "USER_NOT_FOUND" });
    expect(cognitoRefusal(named("TooManyRequestsException"))).toMatchObject({ code: "UNAVAILABLE", reason: "COGNITO_RATE_LIMITED" });
    expect(cognitoRefusal(named("InvalidPasswordException"))).toMatchObject({ code: "INVALID", reason: "COGNITO_INVALID" });
    expect(cognitoRefusal(named("UserLambdaValidationException"))).toMatchObject({ code: "UNAVAILABLE", reason: "TRIGGER_FAILED" });
    expect(cognitoRefusal(named("InternalErrorException"))).toMatchObject({ code: "UNAVAILABLE", reason: "COGNITO_UNAVAILABLE", message: expect.stringContaining("InternalErrorException") });
    const own = new ToolError("FORBIDDEN", "fenced", "QA_FENCE");
    expect(cognitoRefusal(own)).toBe(own);
  });

  it("maps the stage pool's answers: AdminConfirmSignUp of a confirmed account, AdminGetUser of a missing one", async () => {
    const answers = new Map<string, unknown>([
      ["AdminConfirmSignUpCommand", named("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED")],
      ["AdminSetUserPasswordCommand", named("InternalErrorException")],
      ["AdminGetUserCommand", named("UserNotFoundException")],
    ]);
    const client = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        const answer = answers.get(command.constructor.name);
        if (answer instanceof Error) throw answer;
        return answer ?? {};
      }),
    };
    const cognito = stageQaCognito(() => new Date(0), client as never);
    await expect(cognito.adminConfirmSignUp(USERNAME, { signupId: "a".repeat(26) })).rejects.toMatchObject({ code: "CONFLICT", reason: "ALREADY_CONFIRMED" });
    await expect(cognito.setPassword(USERNAME, "Password-123456")).rejects.toMatchObject({ code: "UNAVAILABLE", reason: "COGNITO_UNAVAILABLE" });
    expect(await cognito.accountStatus(USERNAME)).toBe("MISSING");
    answers.set("AdminGetUserCommand", { UserStatus: "UNCONFIRMED" });
    expect(await cognito.accountStatus(USERNAME)).toBe("UNCONFIRMED");
    await expect(cognito.accountStatus("someone@example.org")).rejects.toMatchObject({ code: "FORBIDDEN", reason: "QA_FENCE" });
  });
});

describe("[FL-113] the runner's self-signup is confirmed only by the product's confirmation path", () => {
  it("guest.session refuses an UNCONFIRMED account before touching its password; guest.confirm then confirms it", async () => {
    const calls: string[] = [];
    const kit = qaKit({ mc: testConnector(), overrides: { signup: () => confirmingService(calls) } });
    kit.cognito.users.set(USERNAME, { sub: "s", worldId: `qa-${RUN}-su1`, group: "", status: "UNCONFIRMED" });
    const early = await kit.driver({ action: "guest.session", idempotencyKey: key(40), input: QA });
    expect(early).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "NOT_CONFIRMED" } });
    expect(kit.cognito.users.get(USERNAME)).toMatchObject({ status: "UNCONFIRMED" });
    expect(kit.cognito.users.get(USERNAME)?.password).toBeUndefined();
    expect(kit.cognito.logins).toEqual([]);

    const confirmed = await kit.driver({ action: "guest.confirm", idempotencyKey: key(41), input: { ...QA, signupId: "a".repeat(26) } });
    expect(confirmed).toMatchObject({ ok: true, result: { status: "CONFIRMED" } });
    expect(kit.cognito.confirmed).toHaveLength(1);
    expect(calls).toEqual(["confirm"]);
    expect(await kit.driver({ action: "guest.session", idempotencyKey: key(42), input: QA })).toMatchObject({ ok: true, result: { worldStatus: "READY" } });
  });

  it("guest.confirm of an account Cognito confirmed already takes the repair path instead of failing without a reason", async () => {
    const calls: string[] = [];
    const kit = qaKit({ mc: testConnector(), overrides: { signup: () => confirmingService(calls) } });
    kit.cognito.users.set(USERNAME, { sub: "s", worldId: `qa-${RUN}-su1`, group: "", status: "CONFIRMED" });
    const answer = await kit.driver({ action: "guest.confirm", idempotencyKey: key(43), input: { ...QA, signupId: "a".repeat(26) } });
    expect(answer).toMatchObject({ ok: true, result: { status: "CONFIRMED", worldId: `qa-${RUN}-su1` } });
    expect(calls).toEqual(["confirm"]);
    expect(kit.lines.some((line) => line.includes("qa_driver.already_confirmed"))).toBe(true);
  });

  it("guest.session of a missing account answers NOT_FOUND USER_NOT_FOUND", async () => {
    const kit = qaKit({ mc: testConnector() });
    expect(await kit.driver({ action: "guest.session", idempotencyKey: key(44), input: QA })).toMatchObject({ ok: false, error: { code: "NOT_FOUND", reason: "USER_NOT_FOUND" } });
  });
});
