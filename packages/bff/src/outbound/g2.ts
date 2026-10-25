// Guardrail G2 on the way out (docs/architecture.md §9.4, docs/architecture-integrations.md §4 step
// 3): `ApplyGuardrail` with source OUTPUT over the free text an agent or an operator wrote.
//
//   grounded   a `REPLY` that states figures or facts, and the body of a `FORMAL_ANSWER`: the turn's
//              results (`Runtime/TURN#`) as `grounding_source`, the query of g2-query.ts and the text as
//              `guard_content`; the verdict applies the grounding threshold and, for a `REPLY`, relevance
//   ungrounded every other kind (the challenge, the receipt request, a greeting, a refusal): the text
//              alone, so a short service text never fails grounding; only the denied topics decide
//
// The thresholds and the limits come from the `GuardrailG2` Linkable (infra/guardrail.ts). A text over
// the content limit is never half-checked; a failed call fails closed (nothing leaves without G2).
// The single Bedrock runtime client of the gate (timeouts, retries with backoff, error mapping).
import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput, BedrockRuntimeClient, type GuardrailAssessment, type GuardrailContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { MessageKind } from "@reclamo/shared";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";

/** `Resource.GuardrailG2`: the published version, its thresholds and its input limits. */
export const G2Config = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  groundingThreshold: z.number().min(0).max(1),
  relevanceThreshold: z.number().min(0).max(1),
  queryMaxChars: z.number().int().positive(),
  groundingSourceMaxChars: z.number().int().positive(),
  contentMaxChars: z.number().int().positive(),
});
export type G2Config = z.infer<typeof G2Config>;

export function linkedG2Config(): G2Config {
  return readLinked("GuardrailG2", G2Config);
}

export interface G2Grounding {
  /** The turn's results, one JSON line each. */
  readonly source: string;
  readonly query: string;
}

export interface G2Input {
  readonly kind: MessageKind;
  readonly text: string;
  /** Present for a grounded check (`REPLY` with facts, `FORMAL_ANSWER`). */
  readonly grounding?: G2Grounding;
}

export type G2Failure = "GROUNDING" | "RELEVANCE" | "BLOCKED" | "TOO_LONG";

export interface G2Verdict {
  readonly action: "NONE" | "BLOCKED";
  readonly groundingScore?: number;
  readonly relevanceScore?: number;
  readonly failure?: G2Failure;
}

export interface OutputGuardrail {
  check(input: G2Input): Promise<G2Verdict>;
}

export class GuardrailUnavailableError extends Error {
  override readonly name = "GuardrailUnavailableError";
}

/** One JSON line per tool result, clipped from the oldest side to the limit. */
export function groundingSourceOf(results: readonly unknown[], maxChars: number): string {
  const text = results.map((result) => JSON.stringify(result)).join("\n");
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export function contentBlocks(input: G2Input, config: Pick<G2Config, "queryMaxChars" | "groundingSourceMaxChars">): GuardrailContentBlock[] {
  const guarded: GuardrailContentBlock = { text: { text: input.text, qualifiers: ["guard_content"] } };
  if (input.grounding === undefined) return [guarded];
  return [
    { text: { text: input.grounding.source.slice(-config.groundingSourceMaxChars) || "{}", qualifiers: ["grounding_source"] } },
    { text: { text: input.grounding.query.slice(0, config.queryMaxChars) || "-", qualifiers: ["query"] } },
    guarded,
  ];
}

function scoreOf(assessments: readonly GuardrailAssessment[], type: "GROUNDING" | "RELEVANCE"): number | undefined {
  let score: number | undefined;
  for (const assessment of assessments) {
    for (const filter of assessment.contextualGroundingPolicy?.filters ?? []) {
      if (filter.type === type && filter.score !== undefined) score = score === undefined ? filter.score : Math.min(score, filter.score);
    }
  }
  return score;
}

/** A block of any policy other than contextual grounding: the denied output topics, words, content, PII. */
function blockedByPolicy(assessments: readonly GuardrailAssessment[]): boolean {
  return assessments.some(
    (assessment) =>
      (assessment.topicPolicy?.topics ?? []).some((topic) => topic.action === "BLOCKED") ||
      (assessment.wordPolicy?.customWords ?? []).some((word) => word.action === "BLOCKED") ||
      (assessment.wordPolicy?.managedWordLists ?? []).some((word) => word.action === "BLOCKED") ||
      (assessment.contentPolicy?.filters ?? []).some((filter) => filter.action === "BLOCKED") ||
      (assessment.sensitiveInformationPolicy?.piiEntities ?? []).some((entity) => entity.action === "BLOCKED") ||
      (assessment.sensitiveInformationPolicy?.regexes ?? []).some((regex) => regex.action === "BLOCKED"),
  );
}

export function verdictOf(response: Pick<ApplyGuardrailCommandOutput, "action" | "assessments">, input: Pick<G2Input, "kind" | "grounding">, config: Pick<G2Config, "groundingThreshold" | "relevanceThreshold">): G2Verdict {
  const assessments = response.assessments ?? [];
  const groundingScore = scoreOf(assessments, "GROUNDING");
  const relevanceScore = scoreOf(assessments, "RELEVANCE");
  const scores = { ...(groundingScore === undefined ? {} : { groundingScore }), ...(relevanceScore === undefined ? {} : { relevanceScore }) };
  if (response.action === "GUARDRAIL_INTERVENED" && blockedByPolicy(assessments)) return { action: "BLOCKED", ...scores, failure: "BLOCKED" };
  if (input.grounding === undefined) return response.action === "GUARDRAIL_INTERVENED" ? { action: "BLOCKED", ...scores, failure: "BLOCKED" } : { action: "NONE", ...scores };
  // A grounding check that returned no score checked nothing: fail closed.
  if (groundingScore === undefined || groundingScore < config.groundingThreshold) return { action: "BLOCKED", ...scores, failure: "GROUNDING" };
  if (input.kind === "REPLY" && (relevanceScore === undefined || relevanceScore < config.relevanceThreshold)) return { action: "BLOCKED", ...scores, failure: "RELEVANCE" };
  return { action: "NONE", ...scores };
}

/** `ApplyGuardrail` answers in a few hundred milliseconds: one SDK attempt of 4 s and two of ours. */
export const G2_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 4_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };
const G2_DEADLINE_MS = 10_000;
const RETRYABLE = new Set(["ThrottlingException", "ServiceUnavailableException", "InternalServerException", "ServiceQuotaExceededException", "TimeoutError"]);

export interface BedrockG2Deps {
  readonly client: Pick<BedrockRuntimeClient, "send">;
  readonly config: () => G2Config;
  readonly sleep?: (ms: number) => Promise<void>;
}

let client: BedrockRuntimeClient | undefined;

/** The Bedrock runtime client of `ApplyGuardrail`, one per container. */
export function bedrockRuntimeClient(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient(awsClientConfig(G2_TIMEOUTS));
  return client;
}

export function createBedrockG2(deps: BedrockG2Deps = { client: bedrockRuntimeClient(), config: linkedG2Config }): OutputGuardrail {
  return {
    async check(input) {
      const config = deps.config();
      if (input.text.length > config.contentMaxChars) return { action: "BLOCKED", failure: "TOO_LONG" };
      const command = new ApplyGuardrailCommand({ guardrailIdentifier: config.id, guardrailVersion: config.version, source: "OUTPUT", content: contentBlocks(input, config) });
      try {
        const response = await withDeadline("g2.applyGuardrail", G2_DEADLINE_MS, (signal) =>
          withRetry(() => deps.client.send(command, { abortSignal: signal }), {
            attempts: 3,
            baseDelayMs: 100,
            shouldRetry: (error) => error instanceof Error && RETRYABLE.has(error.name),
            ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
          }),
        );
        return verdictOf(response, input, config);
      } catch (error) {
        throw new GuardrailUnavailableError("ApplyGuardrail failed", { cause: error });
      }
    },
  };
}
