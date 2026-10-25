// EV-1 · grounding (docs/test-plan.md §6, docs/seed-spec.md §12, ADR-0008): each of the 40 questions of
// `evals/grounding.json` is the first message of its own conversation in a QA world, through
// `wa.inbound` and the real Harness. The customer answers the identity challenge if the agent asks it
// (the autopilot's move), the conversation settles, and the eval reads:
//
//   TURN#        the clause ids the turn's tools returned (`turn.inspect`): the expected ones must be there
//   G2           the grounding and relevance scores of every grounded reply the gate checked, sent or
//                refused (`turn.inspect`): what calibrates the threshold of ADR-0008
//   messages     the bodies of the outbound messages (`snapshot`), only to look for forbidden patterns
//                and required facts here; no body leaves this module
//
// One conversation per question: a clause read in an earlier turn would let a later answer skip the
// tool, and the clause would be missing from the question's own turns for a reason that is not grounding.
import { z } from "zod";
import type { ModelsDocument } from "../../packages/bff/src/qa-driver/world-models";
import type { GroundingEntry, GroundingSet } from "./datasets";
import { eligibleModels, spreadOverWorlds } from "./challenge";
import { DriverRefusal, type EvalDriver } from "./driver";
import { answerChallenge, createWorld, destroyWorld, type EvalPersona, type EvalWorld, sendText, settle, snapshotOf } from "./worlds";

/** Conversations per world (ten customers each; the driver clones at most 12). */
export const EV1_PER_WORLD = 10;

/** What the driver's `turn.inspect({worldId, customerId})` answers (qa-driver/actions-turns.ts). */
export const TurnInspection = z.object({
  turns: z.array(
    z.object({
      turnId: z.string(),
      tools: z.array(z.object({ tool: z.string(), clauseIds: z.array(z.string()) })),
      replies: z.array(
        z.object({
          kind: z.string(),
          sent: z.boolean(),
          g2: z.object({ action: z.enum(["NONE", "BLOCKED"]), failure: z.string().optional(), groundingScore: z.number().min(0).max(1).optional(), relevanceScore: z.number().min(0).max(1).optional() }).nullable(),
        }),
      ),
    }),
  ),
});
export type TurnInspection = z.infer<typeof TurnInspection>;

export interface ScoredReply {
  readonly kind: string;
  readonly sent: boolean;
  readonly groundingScore?: number;
  readonly relevanceScore?: number;
  readonly failure?: string;
}

export type Inspection = { readonly kind: "READ"; readonly clauseIds: readonly string[]; readonly replies: readonly ScoredReply[] } | { readonly kind: "BLOCKED"; readonly reason: string };

export interface GroundingObservation {
  readonly id: string;
  readonly identified: boolean;
  readonly settled: boolean;
  /** An outbound REPLY or FORMAL_ANSWER was sent (ALWAYS_ANSWER). */
  readonly answered: boolean;
  /** Forbidden patterns (as written in the set) some outbound body matched. */
  readonly forbiddenHits: readonly string[];
  readonly factsFound: number;
  readonly factsTotal: number;
  readonly inspection: Inspection;
  readonly error?: string;
}

/** Lower case, without accents, every space-like character one space: how facts are looked for. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s  ]+/gu, " ")
    .trim();
}

/** A required fact may name equivalent wordings, separated by " | " ("sin costo | no tienen costo"): any one counts. */
export function factAlternatives(fact: string): string[] {
  return fact.split(" | ").map((alternative) => alternative.trim()).filter((alternative) => alternative !== "");
}

/**
 * Whether one wording of a fact is in the folded text. A wording between slashes ("/direccion[^.]{0,40}vigente/")
 * is a pattern over the folded text, for a fact that is stated by meaning in more shapes than a list can name;
 * any other wording is a plain substring.
 */
export function alternativeFound(alternative: string, folded: string): boolean {
  const pattern = /^\/(.+)\/$/u.exec(alternative)?.[1];
  return pattern === undefined ? folded.includes(fold(alternative)) : new RegExp(pattern, "u").test(folded);
}

/** Forbidden patterns and required facts over the outbound bodies of one conversation. */
export function textChecks(entry: Pick<GroundingEntry, "forbiddenPatterns" | "requiredFacts">, bodies: readonly string[]): { readonly forbiddenHits: string[]; readonly factsFound: number } {
  const forbiddenHits = entry.forbiddenPatterns.filter((pattern) => {
    const regex = new RegExp(pattern, "iu");
    return bodies.some((body) => regex.test(body.normalize("NFC")));
  });
  const folded = fold(bodies.join("\n"));
  const factsFound = entry.requiredFacts.filter((fact) => factAlternatives(fact).some((alternative) => alternativeFound(alternative, folded))).length;
  return { forbiddenHits, factsFound };
}

/** The clause ids and the scored replies of every turn of the conversation. */
export function inspectionOf(raw: TurnInspection): Inspection {
  const clauseIds = [...new Set(raw.turns.flatMap((turn) => turn.tools.flatMap((tool) => tool.clauseIds)))].sort();
  const replies = raw.turns.flatMap((turn) =>
    turn.replies.flatMap((reply): ScoredReply[] =>
      reply.g2 === null
        ? []
        : [
            {
              kind: reply.kind,
              sent: reply.sent,
              ...(reply.g2.groundingScore === undefined ? {} : { groundingScore: reply.g2.groundingScore }),
              ...(reply.g2.relevanceScore === undefined ? {} : { relevanceScore: reply.g2.relevanceScore }),
              ...(reply.g2.failure === undefined ? {} : { failure: reply.g2.failure }),
            },
          ],
    ),
  );
  return { kind: "READ", clauseIds, replies };
}

const ANSWER_KINDS = new Set(["REPLY", "FORMAL_ANSWER"]);
/** What reached the customer: a refused or deferred message is the gate working, not an answer. */
const DELIVERED = new Set(["SENT", "DELIVERED", "READ"]);

async function inspect(driver: EvalDriver, world: EvalWorld, persona: EvalPersona, step: number): Promise<Inspection> {
  try {
    return inspectionOf(TurnInspection.parse(await driver.call("turn.inspect", { worldId: world.worldId, customerId: persona.customerId }, { scenario: world.scenario, step, label: "inspect" })));
  } catch (error) {
    if (error instanceof DriverRefusal && error.blocked) return { kind: "BLOCKED", reason: error.message };
    throw error;
  }
}

async function askOne(driver: EvalDriver, models: ModelsDocument, world: EvalWorld, persona: EvalPersona, entry: GroundingEntry, step: number): Promise<GroundingObservation> {
  await sendText(driver, world, persona, entry.question, step, "question");
  let settled = await settle(driver, world, persona, step);
  // At most two challenges: a second one means the first answer failed, and a third is never asked.
  let identified = false;
  for (let attempt = 1; attempt <= 2 && settled; attempt += 1) {
    if (!(await answerChallenge(driver, models, world, persona, step, attempt))) break;
    identified = true;
    settled = await settle(driver, world, persona, step);
  }
  const snapshot = await snapshotOf(driver, world, persona, step, "final");
  const outbound = snapshot.messages.filter((message) => message.direction === "OUT" && DELIVERED.has(message.status));
  const checks = textChecks(entry, outbound.map((message) => message.body));
  return {
    id: entry.id,
    identified,
    settled,
    answered: outbound.some((message) => message.kind !== null && ANSWER_KINDS.has(message.kind)),
    forbiddenHits: checks.forbiddenHits,
    factsFound: checks.factsFound,
    factsTotal: entry.requiredFacts.length,
    inspection: await inspect(driver, world, persona, step),
  };
}

function failed(entry: GroundingEntry, error: unknown): GroundingObservation {
  const message = error instanceof Error ? error.message : String(error);
  return { id: entry.id, identified: false, settled: false, answered: false, forbiddenHits: [], factsFound: 0, factsTotal: entry.requiredFacts.length, inspection: { kind: "BLOCKED", reason: message }, error: message };
}

export interface Ev1Options {
  readonly set: GroundingSet;
  readonly models: ModelsDocument;
  /** Stops before the next question when the run's budget is spent. */
  readonly withinBudget: () => boolean;
}

export async function runEv1(driver: EvalDriver, options: Ev1Options): Promise<GroundingObservation[]> {
  const entries = options.set.entries;
  const plan = spreadOverWorlds(eligibleModels(options.models), entries.length, EV1_PER_WORLD);
  const observations: GroundingObservation[] = [];
  for (const [index, models] of plan.entries()) {
    const world = await createWorld(driver, `ev1-w${index + 1}`, models);
    try {
      for (const [slot, persona] of world.personas.entries()) {
        const entry = entries[index * EV1_PER_WORLD + slot];
        if (entry === undefined) continue;
        if (!options.withinBudget()) {
          observations.push(failed(entry, new Error("BUDGET: the run's turn budget is spent")));
          continue;
        }
        try {
          observations.push(await askOne(driver, options.models, world, persona, entry, slot + 2));
        } catch (error) {
          observations.push(failed(entry, error));
        }
      }
    } finally {
      await destroyWorld(driver, world);
    }
  }
  return observations;
}
