/// <reference path="../../sst-env.d.ts" />
// The G1 pre-filter of the worker (docs/architecture.md §9.1, docs/design-brief.md §8.5): before the
// Harness, the customer's text of the turn (already normalized and masked) goes through `ApplyGuardrail`
// with G1 and `source INPUT`. `action = GUARDRAIL_INTERVENED` is not enough to block, because an
// anonymization alone also intervenes; the worker reads the assessments:
//
//   topicPolicy.topics[] BLOCKED                                → block (credit offers, legal or
//                                                                 investment advice)
//   contentPolicy.filters[] PROMPT_ATTACK BLOCKED                → block
//   sensitiveInformationPolicy CREDIT_DEBIT_CARD_NUMBER BLOCKED  → block (card data)
//   only ANONYMIZED entries (CUIT/CUIL, DNI, CBU/CVU regexes)    → no block: the turn goes on with
//                                                                  `outputs[0].text` (`GUARDRAIL_MASK`)
//   action NONE                                                  → no block, nothing audited
//
// A BLOCKED entry of any other policy still blocks, fail closed, as `UNLISTED`. The call fails closed
// too: an error of `ApplyGuardrail` fails the event, which SQS retries; the text never reaches the
// Harness without G1 having looked at it.
import { ApplyGuardrailCommand, BedrockRuntimeClient, type ApplyGuardrailCommandInput, type ApplyGuardrailCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";

/** ApplyGuardrail answers in hundreds of milliseconds; the SDK retries throttling within its attempts. */
export const GUARDRAIL_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

/** Which G1 policy blocked: it decides the fixed reply (docs/architecture.md §9.1). */
export const G1Policy = z.enum(["DENIED_TOPIC", "PROMPT_ATTACK", "CARD_DATA", "UNLISTED"]);
export type G1Policy = z.infer<typeof G1Policy>;

export type G1Verdict =
  | { readonly action: "NONE" }
  | { readonly action: "ANONYMIZED"; readonly text: string; readonly kinds: readonly string[] }
  | { readonly action: "BLOCKED"; readonly policy: G1Policy; readonly topics: readonly string[] };

export type G1Answer = Pick<ApplyGuardrailCommandOutput, "action" | "assessments" | "outputs">;

const CARD_ENTITY = "CREDIT_DEBIT_CARD_NUMBER";

function blockedPolicy(answer: G1Answer): { readonly policy: G1Policy; readonly topics: string[] } | undefined {
  const assessments = answer.assessments ?? [];
  const topics = assessments.flatMap((assessment) => (assessment.topicPolicy?.topics ?? []).filter((topic) => topic.action === "BLOCKED").map((topic) => topic.name ?? "topic"));
  if (topics.length > 0) return { policy: "DENIED_TOPIC", topics };
  const filters = assessments.flatMap((assessment) => assessment.contentPolicy?.filters ?? []).filter((filter) => filter.action === "BLOCKED");
  if (filters.some((filter) => filter.type === "PROMPT_ATTACK")) return { policy: "PROMPT_ATTACK", topics: [] };
  const pii = assessments.flatMap((assessment) => assessment.sensitiveInformationPolicy?.piiEntities ?? []).filter((entity) => entity.action === "BLOCKED");
  if (pii.some((entity) => entity.type === CARD_ENTITY)) return { policy: "CARD_DATA", topics: [] };
  const regexes = assessments.flatMap((assessment) => assessment.sensitiveInformationPolicy?.regexes ?? []).filter((regex) => regex.action === "BLOCKED");
  const words = assessments.flatMap((assessment) => [...(assessment.wordPolicy?.customWords ?? []), ...(assessment.wordPolicy?.managedWordLists ?? [])]).filter((word) => word.action === "BLOCKED");
  if (filters.length + pii.length + regexes.length + words.length > 0) return { policy: "UNLISTED", topics: [] };
  return undefined;
}

function anonymizedKinds(answer: G1Answer): string[] {
  const kinds = (answer.assessments ?? []).flatMap((assessment) => [
    ...(assessment.sensitiveInformationPolicy?.regexes ?? []).filter((regex) => regex.action === "ANONYMIZED").map((regex) => regex.name ?? "REGEX"),
    ...(assessment.sensitiveInformationPolicy?.piiEntities ?? []).filter((entity) => entity.action === "ANONYMIZED").map((entity) => entity.type ?? "PII"),
  ]);
  return [...new Set(kinds)].sort();
}

/** The worker's reading of a G1 answer on `text` (§9.1). */
export function classifyG1(answer: G1Answer, text: string): G1Verdict {
  const blocked = blockedPolicy(answer);
  if (blocked !== undefined) return { action: "BLOCKED", ...blocked };
  const kinds = anonymizedKinds(answer);
  if (kinds.length === 0) return { action: "NONE" };
  const output = answer.outputs?.[0]?.text;
  return { action: "ANONYMIZED", text: typeof output === "string" && output.trim() !== "" ? output : text, kinds };
}

export interface G1Prefilter {
  check(text: string): Promise<G1Verdict>;
}

/** `Resource.GuardrailG1` (infra/guardrail.ts). */
export const GuardrailG1Link = z.object({ id: z.string().min(1), version: z.string().min(1) });
export type GuardrailG1Link = z.infer<typeof GuardrailG1Link>;

export type GuardrailSend = (input: ApplyGuardrailCommandInput) => Promise<G1Answer>;

export function createG1Prefilter(deps: { readonly link: () => GuardrailG1Link; readonly send: GuardrailSend }): G1Prefilter {
  return {
    async check(text) {
      const { id, version } = GuardrailG1Link.parse(deps.link());
      const answer = await deps.send({ guardrailIdentifier: id, guardrailVersion: version, source: "INPUT", content: [{ text: { text } }] });
      return classifyG1(answer, text);
    },
  };
}

let runtimeClient: BedrockRuntimeClient | undefined;

/** The pre-filter of the event workers, over `Resource.GuardrailG1` (`bedrock:ApplyGuardrail` on G1 only). */
export function linkedG1Prefilter(): G1Prefilter {
  return createG1Prefilter({
    link: () => readLinked("GuardrailG1", GuardrailG1Link),
    send: (input) => {
      runtimeClient ??= new BedrockRuntimeClient({ region: "us-east-1", ...awsClientConfig(GUARDRAIL_TIMEOUTS) });
      return runtimeClient.send(new ApplyGuardrailCommand(input));
    },
  });
}
