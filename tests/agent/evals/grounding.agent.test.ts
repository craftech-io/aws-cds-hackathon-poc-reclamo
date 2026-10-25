// EV-1 · grounding (scripts/evals/ev1-grounding.ts, docs/seed-spec.md §12) on the run's model: each of the
// 40 questions of evals/grounding.json is the first message of its own conversation in a fresh local
// world; the customer answers the identity challenge if the agent asks it. The gates are the eval's, per
// question: answered (ALWAYS_ANSWER; a question the intake rules hand to a person by code is answered by
// the code's HANDOFF_NOTICE, with no turn and no clause to read), every expected clause read by a tool of
// the conversation (the set's clauseRecall is 1), zero forbidden patterns, every required fact present,
// and zero figures, dates or spans of days or hours that no tool returned. G2's scores are not measured
// here (G2 is a fake that passes); the deterministic verification of the gate still runs.
import { describe, expect, it } from "vitest";
import { clauseIdsOf } from "@reclamo/bff/qa-driver/actions-turns";
import { loadEvalSets } from "../../../scripts/evals/datasets";
import { textChecks } from "../../../scripts/evals/ev1-grounding";
import { SCRIPTED_RUN, openAgentWorld, turnsSummary } from "../support/agent-world";
import { agentSentOf, answerChallenges, outboundOf, say } from "../support/customer";
import { conversationProblems } from "../support/oracles";

const SET = loadEvalSets().grounding;
/** Personas without an open complaint, frozen account or missing opt-in (the eval's EXCLUDED_MODELS stay out). */
const PERSONAS = ["cus-0008", "cus-0009", "cus-0027", "cus-0032"] as const;
const ANSWER_KINDS = new Set(["REPLY", "FORMAL_ANSWER"]);

describe.skipIf(SCRIPTED_RUN)(`EV-1 grounding (agent, ${SET.version})`, () => {
  it.each(SET.entries.map((entry, index) => ({ ...entry, persona: PERSONAS[index % PERSONAS.length] ?? "cus-0008" })))("[EV-1] $id: $question", async (entry) => {
    const world = await openAgentWorld();
    await say(world, entry.persona, entry.question);
    await answerChallenges(world, entry.persona);

    const left = (await outboundOf(world, entry.persona)).filter((message) => message.status !== "BLOCKED");
    const summary = turnsSummary(world.agent.turns);
    // A message the intake rules hand to a person by code (FL-060, "¿Puedo hablar con una persona?") never
    // reaches the model: the code's HANDOFF_NOTICE is its answer and there is no clause read to check.
    const routedByCode = world.agent.turns.length === 0 && left.some((message) => message.kind === "HANDOFF_NOTICE");
    expect(routedByCode || left.some((message) => message.kind !== undefined && ANSWER_KINDS.has(message.kind)), `not answered; ${summary}`).toBe(true);
    const read = clauseIdsOf(world.agent.turns.flatMap((turn) => turn.calls.map((call) => call.output)));
    if (!routedByCode) expect(entry.expectedClauseIds.filter((clauseId) => !read.has(clauseId)), `clauses not read; ${summary}`).toEqual([]);
    const checks = textChecks(entry, left.map((message) => message.body));
    expect(checks.forbiddenHits, "forbidden patterns in what left").toEqual([]);
    expect(checks.factsFound, `required facts ${entry.requiredFacts.join(" · ")} in: ${(await agentSentOf(world, entry.persona)).map((message) => message.body).join(" ¦ ")}`).toBe(entry.requiredFacts.length);
    expect(await conversationProblems(world, entry.persona)).toEqual([]);
  });
});
