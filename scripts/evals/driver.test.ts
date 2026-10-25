import { describe, expect, it } from "vitest";
import { parameterBlock, statement } from "../../infra/bootstrap/template-text";
import { challengeAnswer, eligibleModels, spreadOverWorlds } from "./challenge";
import { loadEvalSets, probeTargetOf } from "./datasets";
import { DriverRefusal, QA_DRIVER_FUNCTION, createEvalDriver, eventually, localContractProblem, runIdFromEnv } from "./driver";
import { fold, inspectionOf, textChecks } from "./ev1-grounding";
import { readingOf } from "./ev2-receipts";
import { TurnBudget, planOf, spendRefusal, srGatePlan } from "./plan";
import { parseRunOptions } from "./run";
import { challengePending } from "./worlds";

const sets = loadEvalSets();
const noSleep = async () => {};

describe("the QaDriver client", () => {
  it("invokes the one function the bootstrap lets qa-runner invoke", () => {
    const defaultOf = (name: string) => /Default: (\S+)/.exec(parameterBlock(name))?.[1];
    expect(QA_DRIVER_FUNCTION).toBe(`${defaultOf("AppName")}-${defaultOf("DeployStage")}-qa-driver`);
    expect(statement("InvokeTheQaDriverOnly")).toContain("function:${AppName}-${DeployStage}-qa-driver");
  });

  it("sends the action with a key of the run, the scenario and the step, and returns the result", async () => {
    const payloads: string[] = [];
    const driver = createEvalDriver({ runId: "18234567890-1", sleep: noSleep, invoke: async (payload) => (payloads.push(payload), { statusCode: 200, payload: JSON.stringify({ ok: true, replayed: false, result: { settled: true } }) }) });
    await expect(driver.call("conv.settleProbe", { worldId: "qa-18234567890-1-ev1-w1" }, { scenario: "ev1-w1", step: 3, label: "settle1" })).resolves.toEqual({ settled: true });
    expect(JSON.parse(payloads[0] ?? "{}")).toEqual({ action: "conv.settleProbe", idempotencyKey: "18234567890-1/ev1-w1/3/settle1", input: { worldId: "qa-18234567890-1-ev1-w1" } });
  });

  it("blocks locally, without calling, an action or an input the deployed contract does not have", async () => {
    let calls = 0;
    const driver = createEvalDriver({ runId: "1-1", sleep: noSleep, invoke: async () => (calls++, { statusCode: 200, payload: "{}" }) });
    const refusal = await driver.call("turn.replay", { worldId: "qa-1-1-ev1-w1" }, { scenario: "ev1-w1", step: 2 }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DriverRefusal);
    expect((refusal as DriverRefusal).blocked).toBe(true);
    // An input the contract does not take (turn.inspect names its customer) is blocked the same way.
    expect(localContractProblem("turn.inspect", { worldId: "qa-1-1-ev1-w1" })).toMatch(/customerId/);
    expect(localContractProblem("turn.inspect", { worldId: "qa-1-1-ev1-w1", customerId: "cus-qa-1-1-ev1-w1-a" })).toBeUndefined();
    expect(localContractProblem("intake.inspect", { worldId: "qa-1-1-ev3-w1", customerId: "cus-qa-1-1-ev3-w1-a" })).toBeUndefined();
    expect(localContractProblem("receipt.readProbe", { worldId: "qa-1-1-ev2", variant: "legible", personaModel: "C01", seq: 1 })).toBeUndefined();
    expect(localContractProblem("receipt.readProbe", { worldId: "qa-1-1-ev2", variant: "tampered-chunk", file: "receipts/tampered-chunk/ev-tampered-chunk-01.png" })).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("retries a transport failure under the same key and surfaces a refusal of the driver as is", async () => {
    const answers = [{ statusCode: 200, functionError: "Unhandled", payload: "{}" }, { statusCode: 200, payload: JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "fence", reason: "QA_FENCE" } }) }];
    const keys: string[] = [];
    const driver = createEvalDriver({ runId: "1-1", sleep: noSleep, invoke: async (payload) => (keys.push((JSON.parse(payload) as { idempotencyKey: string }).idempotencyKey), answers.shift() ?? { statusCode: 500, payload: "" }) });
    const refusal = (await driver.call("snapshot", { worldId: "qa-1-1-ev3-w01" }, { scenario: "ev3-w01", step: 2, label: "after" }).catch((error: unknown) => error)) as DriverRefusal;
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.blocked).toBe(false);
    expect(new Set(keys)).toEqual(new Set(["1-1/ev3-w01/2/after"]));
    expect(keys).toHaveLength(2);
  });

  it("takes the run id from CI only", () => {
    expect(runIdFromEnv({ CI: "true", GITHUB_RUN_ID: "18234567890", GITHUB_RUN_ATTEMPT: "2" })).toBe("18234567890-2");
    expect(() => runIdFromEnv({ GITHUB_RUN_ID: "1" })).toThrow(/only in CI/);
  });

  it("repeats a probe until it is done or out of time", async () => {
    let now = 0;
    let probes = 0;
    const options = { timeoutMs: 30_000, everyMs: 10_000, now: () => now, sleep: async (ms: number) => void (now += ms) };
    expect(await eventually(async () => ++probes, (value) => value >= 3, options)).toEqual({ value: 3, met: true });
    probes = 0;
    now = 0;
    expect(await eventually(async () => ++probes, () => false, options)).toEqual({ value: 4, met: false });
  });
});

describe("datasets, personas and the autopilot's answers", () => {
  it("parses the three sets with their sizes and addresses persona receipts by persona, eval images by key", () => {
    expect([sets.grounding.entries.length, sets.receipts.images.length, sets.receipts.srSubset.length, sets.classifier.entries.length]).toEqual([40, 64, 12, 120]);
    expect(probeTargetOf({ file: "receipts/blurry/c16-2.png", variant: "blurry" })).toEqual({ variant: "blurry", personaModel: "C16", seq: 2 });
    expect(probeTargetOf({ file: "receipts/legible/ev-legible-01.png", variant: "legible" })).toEqual({ variant: "legible", file: "receipts/legible/ev-legible-01.png" });
  });

  it("answers the challenge with the last due date, or the last wallet amount without one", () => {
    expect(challengeAnswer(sets.models, "C02")).toBe("10/09/2026");
    expect(challengeAnswer(sets.models, "C33")).toMatch(/^\$ [\d.]+,\d{2}$/);
  });

  it("never clones a persona with an open complaint, and never one model twice in a world", () => {
    const eligible = eligibleModels(sets.models);
    expect(eligible).not.toContain("C17");
    expect(eligible.length).toBeGreaterThanOrEqual(12);
    const worlds = spreadOverWorlds(eligible, 120, 12);
    expect(worlds).toHaveLength(10);
    for (const world of worlds) expect(new Set(world).size).toBe(world.length);
  });

  it("sees a challenge pending only while the customer has not answered it", () => {
    const out = (kind: string) => ({ messageId: kind, direction: "OUT" as const, kind, status: "SENT", body: "" });
    const inbound = { messageId: "in", direction: "IN" as const, kind: null, status: "RECEIVED", body: "" };
    expect(challengePending([inbound, out("IDENTITY_CHALLENGE")])).toBe(true);
    expect(challengePending([out("IDENTITY_CHALLENGE"), inbound])).toBe(false);
    expect(challengePending([inbound, out("REPLY")])).toBe(false);
  });
});

describe("what the evaluations read", () => {
  it("looks for facts without case or accents and for forbidden patterns as written", () => {
    expect(fold("Diez  DÍAS hábiles")).toBe("diez dias habiles");
    const checks = textChecks({ forbiddenPatterns: ["\\bpag[aá]\\s+(hoy|ya|ahora)\\b", "acciones legales"], requiredFacts: ["10 días hábiles", "email"] }, ["Te respondemos en 10 dias habiles.", "Pagá hoy"]);
    expect(checks).toEqual({ forbiddenHits: ["\\bpag[aá]\\s+(hoy|ya|ahora)\\b"], factsFound: 1 });
  });

  it("counts a required fact when any of its wordings (separated by ' | ') is in what left", () => {
    const fact = "sin costo | no tienen costo";
    expect(textChecks({ forbiddenPatterns: [], requiredFacts: [fact] }, ["Las transferencias entre cuentas no tienen costo."]).factsFound).toBe(1);
    expect(textChecks({ forbiddenPatterns: [], requiredFacts: [fact] }, ["Transferir es sin costo."]).factsFound).toBe(1);
    expect(textChecks({ forbiddenPatterns: [], requiredFacts: [fact] }, ["Transferir cuesta $ 100,00."]).factsFound).toBe(0);
  });

  it("counts a wording between slashes as a pattern over the folded text: gnd-37 by meaning, not by one phrase", () => {
    const entry = sets.grounding.entries.find((candidate) => candidate.id === "gnd-37");
    if (entry === undefined) throw new Error("gnd-37 is missing from the grounding set");
    const found = (body: string) => textChecks(entry, [body]).factsFound;
    expect(found("El cambio de email se confirma escribiendo a la dirección de email que figura vigente en tu cuenta.")).toBe(1);
    expect(found("Escribinos desde la dirección de email que figura actualmente en tu cuenta.")).toBe(1);
    expect(found("Se confirma escribiendo a la DIRECCIÓN VIGENTE.")).toBe(1);
    expect(found("Mandanos un mensaje desde el correo que tenés registrado.")).toBe(1);
    expect(found("Escribinos a soporte y lo cambiamos.")).toBe(0);
    expect(found("Tu email nuevo. Lo dejamos vigente mañana.")).toBe(0);
  });

  it("keeps the clause ids of every turn once and only the replies G2 scored", () => {
    const inspection = inspectionOf({
      turns: [
        { turnId: "t1", tools: [{ tool: "get_terms", clauseIds: ["D-2", "D-1"] }], replies: [{ kind: "REPLY", sent: true, g2: { action: "NONE", groundingScore: 0.9 } }, { kind: "REPLY", sent: true, g2: null }] },
        { turnId: "t2", tools: [{ tool: "check_charge", clauseIds: ["D-2"] }], replies: [] },
      ],
    });
    expect(inspection).toEqual({ kind: "READ", clauseIds: ["D-1", "D-2"], replies: [{ kind: "REPLY", sent: true, groundingScore: 0.9 }] });
  });

  it("reads the reader's outcome and its no-reading answer", () => {
    expect(readingOf({ unavailable: true, reason: "THROTTLED" })).toEqual({ kind: "UNAVAILABLE", reason: "THROTTLED" });
    expect(readingOf({ result: "UNREADABLE", source: "BEDROCK", suspiciousText: false, bedrock: { legibility: "ILLEGIBLE" } })).toEqual({ kind: "READING", result: "UNREADABLE", source: "BEDROCK", suspiciousText: false });
  });
});

describe("spend", () => {
  it("prices the run before sending anything and refuses it without the confirmation and a ceiling that covers it", () => {
    const plan = planOf(["EV-1", "EV-2", "EV-3"], sets);
    expect(plan.turns.high).toBeGreaterThan(plan.turns.low);
    expect(plan.receiptReads).toBe(64 + 12 * 5 + 10);
    expect(plan.usd.high).toBeGreaterThan(plan.usd.low);
    expect(spendRefusal(plan, false, 1_000)).toMatch(/--confirm-spend/);
    expect(spendRefusal(plan, true, plan.usd.high / 2)).toMatch(/--max-usd/);
    expect(spendRefusal(plan, true, plan.usd.high)).toBeUndefined();
    expect(srGatePlan(sets)).toMatchObject({ turns: { high: 0 }, receiptReads: 60 });
  });

  it("starts a conversation only while its turns fit the budget", () => {
    const budget = new TurnBudget(5);
    expect([budget.take(3), budget.take(3), budget.take(2), budget.take(1)]).toEqual([true, false, true, false]);
    expect(budget.spent).toBe(5);
  });

  it("parses the CLI: the SR gate is EV-2 alone, unknown flags are refused", () => {
    expect(parseRunOptions(["--sr-gate", "--confirm-spend", "--max-usd", "5"])).toMatchObject({ evals: ["EV-2"], srGate: true, confirmSpend: true, maxUsd: 5 });
    expect(parseRunOptions(["--eval", "ev3", "--plan-only"])).toMatchObject({ evals: ["EV-3"], planOnly: true });
    expect(() => parseRunOptions(["--eval", "ev9"])).toThrow(RangeError);
    expect(() => parseRunOptions(["--force"])).toThrow(RangeError);
  });
});
