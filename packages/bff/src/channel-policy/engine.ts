// The channel-policy engine (docs/design-brief.md §7, ADR-0006): the `CH-*` rules in the order of
// `CHANNEL_RULES`, evaluated by the outbound gate (outbound/gate.ts, step 1) before every outbound
// message of any sender. The first rule that blocks ends the evaluation and is the decision; a time
// rule (`CH-CONTACT-HOURS`, `CH-MAX-PER-DAY`) that is not met defers the send, and the evaluation goes
// on so that a later block still wins over the deferral. A deferral carries `nextAllowedAt`: the first
// instant at which every time rule allows the send, so the deferred send is not deferred again by the
// rule after it. An allowed send lists every rule that passed. Pure: the instant comes in `clock`, and
// nothing reads the machine's clock. It is our reading of the rules, not legal advice.
//
// Two evaluations share the rules:
//   evaluate      a send decided now (the gate, `DEFERRED_SEND`, `fence.probe`, `gate.probe`); a fact
//                 it needs and does not get fails closed
//   evaluateAsOf  a send that already went out, decided at its own instant from the dated histories
//                 (as-of.ts: `PolicyAudit` and the seed invariant 10)
import type { ChannelRuleId, CollectionCategory } from "../copy/types";
import { toArIso } from "./checks";
import { COLLECTION_LEXICON_VERSION } from "./collection-lexicon";
import { checkNoCollection, checkNoCreditOffer, checkNoForeignLinks, checkNoPaymentRequest, checkNoSensitiveAsk } from "./content";
import { type PolicyContext, buildContext } from "./context";
import { checkMaxPerDay } from "./frequency";
import { checkContactHours } from "./hours";
import { CHANNEL_RULES, RULE_SET_VERSION } from "./kinds";
import { checkRecipientFence } from "./recipients";
import { reroutesFor } from "./reroutes";
import { checkControl, checkCustomerInitiated, checkFormalContent, checkKindChannel, checkOptIn, checkOptOut, checkSender } from "./rules";
import { type EvaluationMode, type PolicyDecision, type PolicyErrorCode, type PolicyInput, PolicyInput as PolicyInputSchema, type RuleCheck, type RuleEvaluation } from "./types";
import { checkWindow, windowAt } from "./window";

/** `TapeEntry.ruleSetVersion`: the rule set and the collection lexicon that decided. */
export const POLICY_VERSION = `${RULE_SET_VERSION}+${COLLECTION_LEXICON_VERSION}`;

type TimeRule = (ctx: PolicyContext, at: Date) => RuleCheck;

interface RuleEntry {
  readonly check: (ctx: PolicyContext) => RuleCheck;
  /** Time rules: the same check at another instant (the search for `nextAllowedAt`). */
  readonly at?: TimeRule;
}

function timed(rule: TimeRule): RuleEntry {
  return { check: (ctx) => rule(ctx, ctx.simNow), at: rule };
}

const RULES: Readonly<Record<ChannelRuleId, RuleEntry>> = {
  "CH-SENDER": { check: checkSender },
  "CH-CONTROL": { check: checkControl },
  "CH-KIND-CHANNEL": { check: checkKindChannel },
  "CH-WA-NO-COLLECTION": { check: checkNoCollection },
  "CH-WA-NO-PAYMENT-REQUEST": { check: checkNoPaymentRequest },
  "CH-NO-CREDIT-OFFER": { check: checkNoCreditOffer },
  "CH-RECIPIENT-FENCE": { check: checkRecipientFence },
  "CH-OPTIN": { check: checkOptIn },
  "CH-OPTOUT": { check: checkOptOut },
  "CH-WA-CUSTOMER-INITIATED": { check: checkCustomerInitiated },
  "CH-WA-24H": { check: checkWindow },
  "CH-CONTACT-HOURS": timed(checkContactHours),
  "CH-MAX-PER-DAY": timed(checkMaxPerDay),
  "CH-NO-SENSITIVE-ASK": { check: checkNoSensitiveAsk },
  "CH-NO-FOREIGN-LINKS": { check: checkNoForeignLinks },
  "CH-FORMAL-CONTENT": { check: checkFormalContent },
};

const TIME_RULES: readonly TimeRule[] = CHANNEL_RULES.flatMap((ruleId) => {
  const rule = RULES[ruleId].at;
  return rule === undefined ? [] : [rule];
});

/** A year of weekends, holidays and daily caps; past it the inputs are broken, not busy. */
const MAX_SEARCH_ROUNDS = 400;

/** From the first deferral, the first instant at which no time rule defers any more. */
function firstAllowedInstant(ctx: PolicyContext, from: Date): Date {
  let at = from;
  for (let round = 0; round < MAX_SEARCH_ROUNDS; round += 1) {
    let moved = false;
    for (const rule of TIME_RULES) {
      const { result, next } = rule(ctx, at);
      if (result === "DEFER" && next !== undefined && next.getTime() > at.getTime()) {
        at = next;
        moved = true;
      }
    }
    if (!moved) return at;
  }
  throw new RangeError(`no instant within ${MAX_SEARCH_ROUNDS} rounds satisfies the time rules`);
}

export interface EvaluateOptions {
  /** Evaluate every rule instead of stopping at the first block (`PolicyAudit` reports every breach). */
  readonly exhaustive?: boolean;
}

interface Hit {
  readonly ruleId: ChannelRuleId;
  readonly check: RuleCheck;
}

function errorCodeOf(hit: Hit): PolicyErrorCode {
  if (hit.check.result === "DEFER") return "DEFERRED";
  return hit.check.errorCode ?? "POLICY_DENIED";
}

function collectionOf(hits: readonly Hit[]): CollectionCategory[] | undefined {
  const categories = [...new Set(hits.flatMap((hit) => hit.check.categories ?? []))];
  return categories.length === 0 ? undefined : categories;
}

function decide(ctx: PolicyContext, evaluated: readonly RuleEvaluation[], blocks: readonly Hit[], deferrals: readonly Hit[]): PolicyDecision {
  const common = {
    evaluated,
    ruleSetVersion: POLICY_VERSION,
    reply: ctx.reply === true,
    ...(ctx.byWhatsApp && ctx.history !== undefined ? { window: windowAt(ctx) } : {}),
  };
  const [blocked] = blocks;
  if (blocked !== undefined) {
    const reroutes = reroutesFor(blocked.ruleId, ctx);
    const categories = collectionOf(blocks);
    return {
      ...common,
      decision: "BLOCKED",
      ruleIds: blocks.map((hit) => hit.ruleId),
      errorCode: errorCodeOf(blocked),
      reason: blocked.check.detail,
      ...(reroutes === undefined ? {} : { reroutes }),
      ...(categories === undefined ? {} : { collectionCategories: categories }),
    };
  }
  const [deferred] = deferrals;
  if (deferred !== undefined) {
    const next = firstAllowedInstant(ctx, deferred.check.next ?? ctx.simNow);
    return { ...common, decision: "DEFERRED", ruleIds: deferrals.map((hit) => hit.ruleId), errorCode: "DEFERRED", reason: deferred.check.detail, nextAllowedAt: toArIso(next) };
  }
  return { ...common, decision: "ALLOWED", ruleIds: evaluated.filter((entry) => entry.result === "PASS").map((entry) => entry.ruleId) };
}

function run(ctx: PolicyContext, options: EvaluateOptions): PolicyDecision {
  const evaluated: RuleEvaluation[] = [];
  const blocks: Hit[] = [];
  const deferrals: Hit[] = [];
  for (const ruleId of CHANNEL_RULES) {
    const check = RULES[ruleId].check(ctx);
    evaluated.push({ ruleId, result: check.result, detail: check.detail });
    if (check.result === "DEFER") deferrals.push({ ruleId, check });
    if (check.result !== "BLOCK") continue;
    blocks.push({ ruleId, check });
    if (options.exhaustive !== true) break;
  }
  return decide(ctx, evaluated, blocks, deferrals);
}

/** Evaluation under a mode; `evaluate` and `evaluateAsOf` are the two entries. */
export function evaluateIn(mode: EvaluationMode, input: PolicyInput, options: EvaluateOptions = {}): PolicyDecision {
  return run(buildContext(PolicyInputSchema.parse(input), mode), options);
}

/** A send decided now: `clock` is the world's "now"; a missing fact fails closed. */
export function evaluate(input: PolicyInput, options: EvaluateOptions = {}): PolicyDecision {
  return evaluateIn("SEND", input, options);
}
