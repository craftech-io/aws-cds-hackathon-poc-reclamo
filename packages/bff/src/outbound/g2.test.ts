// G2 on the way out: the verdict from `ApplyGuardrail` with the linked thresholds, failing closed
// when a grounded check returns no score, and the single client with its retries and its refusal of
// a text over the content limit.
import { describe, expect, it } from "vitest";
import { type G2Config, GuardrailUnavailableError, contentBlocks, createBedrockG2, groundingSourceOf, verdictOf } from "./g2";

const CONFIG: G2Config = { id: "gr-test", version: "3", groundingThreshold: 0.75, relevanceThreshold: 0.5, queryMaxChars: 1_000, groundingSourceMaxChars: 100_000, contentMaxChars: 5_000 };
const GROUNDED = { kind: "REPLY" as const, grounding: { source: '{"balance":"$ 64.210,00"}', query: "¿cuánto debo?" } };
const scores = (grounding: number, relevance: number) => [{ contextualGroundingPolicy: { filters: [{ type: "GROUNDING" as const, threshold: 0.75, score: grounding, action: "NONE" as const }, { type: "RELEVANCE" as const, threshold: 0.5, score: relevance, action: "NONE" as const }] } }];

describe("G2 verdict", () => {
  it("passes a grounded reply above both thresholds and blocks below either one, with the scores", () => {
    expect(verdictOf({ action: "NONE", assessments: scores(0.9, 0.8) }, GROUNDED, CONFIG)).toEqual({ action: "NONE", groundingScore: 0.9, relevanceScore: 0.8 });
    expect(verdictOf({ action: "NONE", assessments: scores(0.6, 0.8) }, GROUNDED, CONFIG)).toMatchObject({ action: "BLOCKED", failure: "GROUNDING", groundingScore: 0.6 });
    expect(verdictOf({ action: "NONE", assessments: scores(0.9, 0.3) }, GROUNDED, CONFIG)).toMatchObject({ action: "BLOCKED", failure: "RELEVANCE", relevanceScore: 0.3 });
  });

  it("relevance does not apply to a written answer", () => {
    expect(verdictOf({ action: "NONE", assessments: scores(0.9, 0.1) }, { ...GROUNDED, kind: "FORMAL_ANSWER" }, CONFIG).action).toBe("NONE");
  });

  it("a grounded check without a score checked nothing: blocked", () => {
    expect(verdictOf({ action: "NONE", assessments: [] }, GROUNDED, CONFIG)).toMatchObject({ action: "BLOCKED", failure: "GROUNDING" });
  });

  it("a denied topic blocks any text; an ungrounded text passes unless the guardrail intervened", () => {
    const topic = [{ topicPolicy: { topics: [{ name: "collection", type: "DENY" as const, action: "BLOCKED" as const }] } }];
    expect(verdictOf({ action: "GUARDRAIL_INTERVENED", assessments: topic }, GROUNDED, CONFIG)).toMatchObject({ action: "BLOCKED", failure: "BLOCKED" });
    expect(verdictOf({ action: "NONE", assessments: [] }, { kind: "IDENTITY_CHALLENGE" }, CONFIG)).toEqual({ action: "NONE" });
    expect(verdictOf({ action: "GUARDRAIL_INTERVENED", assessments: [] }, { kind: "IDENTITY_CHALLENGE" }, CONFIG)).toMatchObject({ action: "BLOCKED" });
  });
});

describe("G2 content", () => {
  it("sends the turn's results, the query and the text with their qualifiers; an ungrounded check sends the text alone", () => {
    expect(contentBlocks({ ...GROUNDED, text: "hola" }, CONFIG).map((block) => block.text?.qualifiers)).toEqual([["grounding_source"], ["query"], ["guard_content"]]);
    expect(contentBlocks({ kind: "RECEIPT_REQUEST", text: "mandame la foto" }, CONFIG)).toEqual([{ text: { text: "mandame la foto", qualifiers: ["guard_content"] } }]);
  });

  it("keeps the newest results when the source is over the limit", () => {
    expect(groundingSourceOf([{ a: 1 }, { b: 2 }], 7)).toBe('{"b":2}');
  });
});

describe("G2 client", () => {
  it("refuses a text over the content limit without calling Bedrock", async () => {
    let calls = 0;
    const g2 = createBedrockG2({ client: { send: async () => void calls++ } as never, config: () => CONFIG });
    expect(await g2.check({ kind: "REPLY", text: "a".repeat(5_001) })).toEqual({ action: "BLOCKED", failure: "TOO_LONG" });
    expect(calls).toBe(0);
  });

  it("retries a throttle and fails closed when Bedrock stays unavailable", async () => {
    let calls = 0;
    const throttled = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    const flaky = createBedrockG2({ client: { send: async () => (++calls < 2 ? Promise.reject(throttled) : { action: "NONE", assessments: [] }) } as never, config: () => CONFIG, sleep: async () => undefined });
    expect(await flaky.check({ kind: "IDENTITY_CHALLENGE", text: "contame tu fecha de nacimiento" })).toEqual({ action: "NONE" });
    expect(calls).toBe(2);
    const down = createBedrockG2({ client: { send: async () => Promise.reject(throttled) } as never, config: () => CONFIG, sleep: async () => undefined });
    await expect(down.check({ kind: "IDENTITY_CHALLENGE", text: "hola" })).rejects.toBeInstanceOf(GuardrailUnavailableError);
  });
});
