// The named security decisions (docs/architecture.md §12): one line with the fixed metric field per
// refusal of a security rule, its name and nothing of the person: sign-up refusals, SMS caps, refused
// numbers, and the console's refusals (second factor pending, blocked account, another world).
import { describe, expect, it } from "vitest";
import { createMemoryAudit, createMemoryDirectory, createTestIssuer, staffRow } from "../auth/testing";
import { createMemoryConnector } from "../connector/memory/connector";
import { signupService } from "../guests/signup";
import { createSignupHarness, startInput } from "../guests/testing/harness";
import { signupRuntimeKeys } from "../leads/keys";
import { SIGNUP_LIMITS } from "../leads/limits";
import type { ContextDeps } from "../routers/deps";
import { createCaller } from "../routers/index";
import { createContextFactory } from "../routers/trpc";
import { memorySmsSender, testSecondFactor } from "../second-factor/doubles";
import { createLogger } from "./log";
import { SECURITY_DECISION_METRIC, recordSecurityDecision } from "./security-decision";

const decisions = (lines: readonly string[]) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.metric === SECURITY_DECISION_METRIC);

const PERSONAL = ["ana.prospecto@empresa-ficticia.ar", "+5491155550100", "5491155550100", "+34612345678", "203.0.113.7"];

describe("security decisions with a name [FL-131] [FL-132]", () => {
  it("writes one warn line with the fixed metric, the decision and the path, and nothing else", () => {
    const lines: string[] = [];
    recordSecurityDecision(createLogger({ sink: (line) => void lines.push(line) }), "ACCOUNT_BLOCKED", "inbox.list");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "warn", message: "security.decision", metric: "SecurityDecisions", decision: "ACCOUNT_BLOCKED", path: "inbox.list" });
  });

  it("[FL-112] [FL-118] names every refusal of signup.start that is a security rule, never a typo, and no personal data", async () => {
    const lines: string[] = [];
    const harness = await createSignupHarness({ logLines: lines }).ready();
    await harness.signup.start(startInput({ email: "ana@yopmail.com" }), "203.0.113.7");
    await harness.signup.start(startInput({ phone: "+34612345678" }), "203.0.113.7");
    await harness.signup.start(startInput({ phone: "+3197010203040" }), "203.0.113.7");
    await harness.signup.start(startInput({ phone: "11 5555" }), "203.0.113.7");
    await harness.store.write({ kind: "put", table: "Runtime", item: { ...signupRuntimeKeys.globalDay(harness.now()), count: SIGNUP_LIMITS.globalPerDay } });
    await harness.signup.start(startInput(), "203.0.113.7");
    expect(decisions(lines).map((line) => line.decision)).toEqual(["SIGNUP_EMAIL_NOT_ACCEPTED", "SIGNUP_PHONE_COUNTRY_NOT_ALLOWED", "SIGNUP_PHONE_NOT_ACCEPTED", "SIGNUP_RATE_LIMITED"]);
    const text = JSON.stringify(decisions(lines));
    for (const value of PERSONAL) expect(text, value).not.toContain(value);
  });

  it("[FL-112] counts a mail server at a temporary-mail service's address as SIGNUP_EMAIL_NOT_ACCEPTED, with its cause", async () => {
    const lines: string[] = [];
    const harness = await createSignupHarness({ logLines: lines }).ready();
    const service = signupService({ ...harness.deps, resolver: { inspect: async () => ({ status: "RECEIVES", exchangers: ["mx.nombre-nuevo.com"], addresses: ["78.47.124.133"] }) } });
    expect(await service.start(startInput({ email: "ana@nombre-nuevo.com" }), "203.0.113.7")).toEqual({ status: "EMAIL_NOT_ACCEPTED" });
    expect(decisions(lines).map((line) => line.decision)).toEqual(["SIGNUP_EMAIL_NOT_ACCEPTED"]);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.find((line) => line.message === "signup.email_not_accepted")).toMatchObject({ cause: "DISPOSABLE_MAIL_SERVER" });
    for (const value of ["ana@nombre-nuevo.com", "78.47.124.133", "203.0.113.7"]) expect(lines.join("\n"), value).not.toContain(value);
  });

  it("[FL-131] [FL-130] [FL-132] names the SMS caps, the refused numbers and the console's refusals", async () => {
    const lines: string[] = [];
    const issuer = createTestIssuer();
    const directory = createMemoryDirectory();
    directory.setWorld("demo", "READY");
    directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", "sub-op-01"));
    const audit = createMemoryAudit();
    const { connector, store } = createMemoryConnector({ now: () => new Date() });
    const deps: ContextDeps = {
      verifier: issuer.verifier(),
      directory,
      audit,
      wallClock: () => new Date(),
      loggerFor: (correlationId) => createLogger({ correlationId, level: "info", sink: (line) => void lines.push(line) }),
      secondFactor: testSecondFactor({ ctx: { store, now: () => new Date() }, worlds: connector.worlds, audit, sms: memorySmsSender() }),
    };
    const contextFor = createContextFactory(() => deps);
    const caller = async (claims: Record<string, unknown> = {}) => {
      const token = issuer.idToken({ sub: "sub-op-01", worldId: "demo", staffId: "stf-operator-01", role: "OPERATOR", ...claims });
      return createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}`, "x-reclamo-viewer-ip": "203.0.113.7" } } }));
    };
    await (await caller()).inbox.list({}).catch(() => undefined);
    await (await caller()).phone.sendCode({ phone: "+34612345678" });
    await (await caller()).phone.sendCode({ phone: "+447012345678" });
    await store.write({ kind: "put", table: "Runtime", item: { pk: `SMSCAP#${new Date().toISOString().slice(0, 10)}`, sk: "META", count: 999 } });
    await (await caller()).phone.sendCode({ phone: "+5491155550100" });
    directory.putStaff(staffRow("demo", "stf-operator-01", "OPERATOR", "sub-op-01", { blocked: true }));
    await (await caller()).inbox.list({}).catch(() => undefined);
    // A token naming a staff row that is not its own (another account's, or another world's).
    await (await caller({ staffId: "stf-operator-02" })).inbox.list({}).catch(() => undefined);
    expect(decisions(lines).map((line) => line.decision)).toEqual(["SECOND_FACTOR_PENDING", "PHONE_COUNTRY_NOT_ALLOWED", "PHONE_NOT_ACCEPTED", "SMS_CAP_GLOBAL", "ACCOUNT_BLOCKED", "STAFF_INACTIVE"]);
    const text = JSON.stringify(decisions(lines));
    for (const value of [...PERSONAL, "sub-op-01"]) expect(text, value).not.toContain(value);
  });
});
