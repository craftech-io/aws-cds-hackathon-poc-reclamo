// The scripted Harness of the local flows (docs/test-plan.md §2, level LF): it receives the real request
// the worker built (system prompt and envelope), reads the envelope as the model would (session token,
// event, facts, inbound text, attachments, preloaded `<tool-result>`s) and runs the plan the test wrote
// for that turn — `[{tool, input}]` — through the local Gateway (Cedar, then the target), copying the
// turn's `sessionToken` into every call as the model is told to. What happens around the plan is the
// point: session, wrapper, fences, Cedar, state machine, gate, transports, register, tape, obligations.
import type { HarnessClient, HarnessTurnRequest, HarnessTurnResult, TokenUsage } from "@reclamo/bff/agent/harness-client";
import type { GatewayAnswer, LocalGateway } from "./gateway";

export interface EnvelopeFact {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** What one turn's envelope says, parsed. */
export interface ScriptedTurn {
  /** 1 for the first turn this Harness answered. */
  readonly index: number;
  readonly request: HarnessTurnRequest;
  readonly sessionToken: string;
  readonly event: { readonly type: string; readonly id: string; readonly at: string };
  readonly facts: readonly EnvelopeFact[];
  /** The inbound text the envelope carries (already masked by the worker), unescaped, if any. */
  readonly inbound?: string;
  readonly attachments: readonly Readonly<Record<string, string>>[];
  /** The reads the worker preloaded, by tool. */
  readonly preloaded: Readonly<Record<string, unknown>>;
}

export interface CallResult {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly answer: GatewayAnswer;
}

export interface PlannedCall {
  readonly tool: string;
  /** The arguments without `sessionToken` (added from the envelope), or built from the earlier results of the turn. */
  readonly input?: Readonly<Record<string, unknown>> | ((earlier: readonly CallResult[], turn: ScriptedTurn) => Readonly<Record<string, unknown>>);
  /** A call without the token (what a model that forgot it would send). */
  readonly withoutSessionToken?: boolean;
}

export interface TurnPlan {
  readonly calls: readonly PlannedCall[];
  /** The turn note (the last assistant text); never a message to anyone. */
  readonly note?: string;
  /** `end_turn` by default; `max_tokens`, `guardrail_intervened`… for the worker's other paths. */
  readonly stopReason?: string;
  readonly usage?: Partial<TokenUsage>;
}

export type PlanSource = (turn: ScriptedTurn) => TurnPlan | readonly PlannedCall[] | Promise<TurnPlan | readonly PlannedCall[]>;

export interface ScriptedHarness extends HarnessClient {
  readonly turns: ScriptedTurn[];
  /** Every Gateway call of every turn, in order. */
  readonly results: CallResult[];
  /** Replaces the plan source (a test scripts each step as it goes). */
  script(plans: PlanSource | readonly (TurnPlan | readonly PlannedCall[])[]): void;
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 1_200, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 };

function unescape(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function attributesOf(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)].map((match) => [match[1] ?? "", unescape(match[2] ?? "")]));
}

/** Reads an envelope of agent/envelope.ts; throws on one without session or event (a bug of the worker). */
export function parseEnvelope(envelope: string): Omit<ScriptedTurn, "index" | "request"> {
  const sessionToken = /^<session token="([^"]+)"\/>$/m.exec(envelope)?.[1];
  const eventLine = /^<event ([^>]*)\/>$/m.exec(envelope)?.[1];
  if (sessionToken === undefined || eventLine === undefined) throw new Error("the envelope has no session or event line");
  const event = attributesOf(eventLine);
  const factsBlock = /^<facts>\n([\s\S]*?)\n?<\/facts>$/m.exec(envelope)?.[1] ?? "";
  const facts = factsBlock
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.indexOf(" ");
      return { name: space < 0 ? line : line.slice(0, space), attributes: space < 0 ? {} : attributesOf(line.slice(space)) };
    });
  const inbound = /^<(inbound-[0-9a-f]{12})[^>]*>\n?([\s\S]*?)\n?<\/\1>$/m.exec(envelope)?.[2];
  const attachments = [...envelope.matchAll(/^<attachment ([^>]*)\/>$/gm)].map((match) => attributesOf(match[1] ?? ""));
  const preloaded = Object.fromEntries([...envelope.matchAll(/^<tool-result tool="([a-z_]+)">(.*)<\/tool-result>$/gm)].map((match) => [match[1] ?? "", JSON.parse(match[2] ?? "null") as unknown]));
  return {
    sessionToken,
    event: { type: event.type ?? "", id: event.id ?? "", at: event.at ?? "" },
    facts,
    ...(inbound === undefined ? {} : { inbound: unescape(inbound) }),
    attachments,
    preloaded,
  };
}

function planOf(answer: TurnPlan | readonly PlannedCall[]): TurnPlan {
  return Array.isArray(answer) ? { calls: answer } : (answer as TurnPlan);
}

export function createScriptedHarness(gateway: LocalGateway, initial?: PlanSource | readonly (TurnPlan | readonly PlannedCall[])[]): ScriptedHarness {
  let source: PlanSource = () => {
    throw new Error("the test scripted no plan for this turn");
  };
  const turns: ScriptedTurn[] = [];
  const results: CallResult[] = [];
  const harness: ScriptedHarness = {
    turns,
    results,
    script(plans) {
      if (typeof plans === "function") {
        source = plans;
        return;
      }
      const queue = [...plans];
      source = (turn) => {
        const next = queue.shift();
        if (next === undefined) throw new Error(`the test scripted no plan for turn ${turn.index} (${turn.event.type})`);
        return next;
      };
    },
    async invoke(request): Promise<HarnessTurnResult> {
      const turn: ScriptedTurn = { index: turns.length + 1, request, ...parseEnvelope(request.envelope) };
      turns.push(turn);
      const plan = planOf(await source(turn));
      const earlier: CallResult[] = [];
      for (const step of plan.calls) {
        const asked = typeof step.input === "function" ? step.input(earlier, turn) : (step.input ?? {});
        const input = step.withoutSessionToken === true ? { ...asked } : { ...asked, sessionToken: turn.sessionToken };
        const result: CallResult = { tool: step.tool, input, answer: await gateway.call(step.tool, input) };
        earlier.push(result);
        results.push(result);
      }
      const stopReason = plan.stopReason ?? "end_turn";
      const outcome = stopReason === "end_turn" ? "COMPLETED" : stopReason === "guardrail_intervened" || stopReason === "content_filtered" ? "GUARDRAIL" : "INCOMPLETE";
      return { outcome, stopReason, note: plan.note ?? "Turno guionado.", usage: { ...DEFAULT_USAGE, ...plan.usage }, toolUses: plan.calls.length, attempts: 1 };
    },
  };
  if (initial !== undefined) harness.script(initial);
  return harness;
}

/** The successful output of a call, or a thrown error naming what the Gateway or the target answered. */
export function outputOf(result: CallResult | undefined): Readonly<Record<string, unknown>> {
  if (result?.answer.kind !== "RESULT") throw new Error(`the call ${result?.tool ?? "(none)"} did not reach its target`);
  const response = result.answer.response;
  if (!response.ok) throw new Error(`${result.tool} answered ${response.error.code}${response.error.reason === undefined ? "" : ` ${response.error.reason}`}`);
  return response as Readonly<Record<string, unknown>>;
}
