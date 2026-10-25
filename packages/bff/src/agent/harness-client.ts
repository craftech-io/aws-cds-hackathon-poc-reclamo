/// <reference path="../../sst-env.d.ts" />
// The one client of the Harness (docs/architecture.md §9.1): `InvokeHarness` on the `live` endpoint with
// the conversation's `runtimeSessionId`, the actor `w-<worldId>-<customerId>-e<worldEpoch>`, the turn
// envelope as the only user message and the system prompt of the turn (it names that turn's random
// delimiter, agent/system-prompt.ts). Never `model` nor `tools` from the edge: the Harness keeps the
// ones the IaC gave it (infra/agentcore.ts).
//
// It reads the stream to the end: the text of the last assistant message is the turn note (never sent),
// `messageStop.stopReason` says how the turn ended and every `metadata.usage` adds to the tokens of the
// turn. A `ThrottlingException` of the call is retried with exponential backoff and full jitter, at most
// 3 times and only while the turn's deadline leaves room for a whole attempt; past that the caller puts
// the event back on the queue (docs/architecture.md §7). Nothing else is retried here: a call that
// reached the model may already have used tools.
//
// Checked against the installed `@aws-sdk/client-bedrock-agentcore` (3.1135.0) `.d.ts`:
//   - `InvokeHarnessRequest` takes `actorId`, `maxIterations` and `timeoutSeconds` per invocation;
//   - it has no session attribute that reaches the Gateway outside the user's text, so the
//     `sessionToken` travels in the envelope (residual risk 2 of docs/architecture.md §13);
//   - `HarnessStopReason` lists `content_filtered` and no `guardrail_intervened`; both are read as a
//     guardrail block, since the stream may carry a value the enum does not list.
import { BedrockAgentCoreClient, InvokeHarnessCommand, type InvokeHarnessCommandInput, type InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";
import { awsClientConfig } from "../lib/clients";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { readLinked } from "../lib/resource";
import { backoffDelayMs } from "../lib/retry";

const REGION = "us-east-1";

/**
 * `Resource.Harness` (infra/agentcore.ts, WP-31): what the workers need to invoke the `live` endpoint and
 * to read the customer's long-term memory before the turn (`memoryId`, `bedrock-agentcore:RetrieveMemoryRecords`).
 */
export const HarnessLink = z.object({
  harnessArn: z.string().min(1),
  endpointName: z.string().min(1),
  timeoutSeconds: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
  memoryId: z.string().min(1).optional(),
});
export type HarnessLink = z.infer<typeof HarnessLink>;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Retries of a throttled call ("hasta 3 veces", docs/architecture.md §7). */
export const HARNESS_THROTTLE_RETRIES = 3;
/** Backoff of a throttled call: full jitter over 1 s, 2 s, 4 s. */
export const HARNESS_BACKOFF = { baseDelayMs: 1_000, maxDelayMs: 8_000 } as const;
/** What an attempt may take beyond the Harness's own `timeoutSeconds` (stream start and tail). */
export const HARNESS_ATTEMPT_GRACE_MS = 30_000;
/** The turn note is a `TurnNote` (domain/conversation.ts); the worker keeps at most this much of it. */
export const TURN_NOTE_MAX_CHARS = 4_000;

/** How the turn ended, from the last `messageStop.stopReason`. */
export const HarnessOutcome = z.enum(["COMPLETED", "GUARDRAIL", "INCOMPLETE"]);
export type HarnessOutcome = z.infer<typeof HarnessOutcome>;

const COMPLETED_STOPS: ReadonlySet<string> = new Set(["end_turn", "stop_sequence"]);
/** A guardrail ended the turn: its text is the guardrail's sentinel and never leaves (§9.1). */
export const GUARDRAIL_STOPS: ReadonlySet<string> = new Set(["guardrail_intervened", "content_filtered"]);

export function outcomeOf(stopReason: string): HarnessOutcome {
  if (COMPLETED_STOPS.has(stopReason)) return "COMPLETED";
  if (GUARDRAIL_STOPS.has(stopReason)) return "GUARDRAIL";
  return "INCOMPLETE";
}

export interface HarnessTurnRequest {
  readonly runtimeSessionId: string;
  readonly actorId: string;
  /** The user message: the envelope of agent/envelope.ts. */
  readonly envelope: string;
  /** `buildSystemPrompt({ delimiter })` of the turn. */
  readonly systemPrompt: string;
  /** Real instant (epoch ms) the turn must be over by: the worker's timeout minus its margin. */
  readonly deadlineMs: number;
}

export interface HarnessTurnResult {
  readonly outcome: HarnessOutcome;
  /** Raw stop reason (`end_turn`, `max_tokens`, `content_filtered`…); `none` if the stream never said. */
  readonly stopReason: string;
  /** Text of the last assistant message: the turn note, never a message to anyone. */
  readonly note: string;
  readonly usage: TokenUsage;
  /** Tool calls the model made (Gateway calls, whatever their result). */
  readonly toolUses: number;
  /** Invocations, the throttled ones included. */
  readonly attempts: number;
}

export type HarnessErrorKind = "THROTTLED" | "TIMEOUT" | "STREAM" | "REQUEST";

/** A turn that could not run or did not end: `THROTTLED` goes back to the queue, the rest fail the turn. */
export class HarnessError extends Error {
  override readonly name = "HarnessError";
  constructor(
    readonly kind: HarnessErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type HarnessSend = (input: InvokeHarnessCommandInput, options: { readonly abortSignal: AbortSignal }) => Promise<{ readonly stream?: AsyncIterable<InvokeHarnessStreamOutput> | undefined }>;

export interface HarnessClient {
  invoke(request: HarnessTurnRequest): Promise<HarnessTurnResult>;
}

export interface HarnessClientDeps {
  readonly link: () => HarnessLink;
  readonly send: HarnessSend;
  /** Real time in ms (the deadline and the backoff are real). */
  readonly nowMs: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export function isThrottling(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return named === "ThrottlingException" || named === "TooManyRequestsException" || status === 429;
}

/** The request: the Harness of the link, its `live` endpoint, the turn's ids, envelope and prompt. */
export function harnessRequest(link: HarnessLink, request: HarnessTurnRequest): InvokeHarnessCommandInput {
  return {
    harnessArn: link.harnessArn,
    qualifier: link.endpointName,
    runtimeSessionId: request.runtimeSessionId,
    actorId: request.actorId,
    messages: [{ role: "user", content: [{ text: request.envelope }] }],
    systemPrompt: [{ text: request.systemPrompt }],
    maxIterations: link.maxIterations,
    timeoutSeconds: link.timeoutSeconds,
  };
}

interface StreamState {
  current: string;
  lastText: string;
  stopReason: string;
  toolUses: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

function streamFailure(event: InvokeHarnessStreamOutput): HarnessError | undefined {
  if (event.internalServerException !== undefined) return new HarnessError("STREAM", "the Harness stream failed (internal error)");
  if (event.validationException !== undefined) return new HarnessError("STREAM", "the Harness stream failed (validation)");
  if (event.runtimeClientError !== undefined) return new HarnessError("STREAM", "the Harness stream failed (runtime client error)");
  return undefined;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function absorb(state: StreamState, event: InvokeHarnessStreamOutput): void {
  if (event.messageStart !== undefined) {
    state.current = "";
    return;
  }
  if (event.contentBlockStart?.start?.toolUse !== undefined) state.toolUses += 1;
  const text = event.contentBlockDelta?.delta?.text;
  if (typeof text === "string") state.current += text;
  if (event.messageStop !== undefined) {
    state.stopReason = event.messageStop.stopReason ?? "none";
    if (state.current.trim() !== "") state.lastText = state.current;
  }
  const usage = event.metadata?.usage;
  if (usage !== undefined) {
    // One metadata event per model call: the turn spends their sum.
    state.usage.inputTokens += count(usage.inputTokens);
    state.usage.outputTokens += count(usage.outputTokens);
    state.usage.cacheReadTokens += count(usage.cacheReadInputTokens);
    state.usage.cacheWriteTokens += count(usage.cacheWriteInputTokens);
  }
}

/** Reads a whole Harness stream into the turn's result (without `attempts`). */
export async function readHarnessStream(stream: AsyncIterable<InvokeHarnessStreamOutput>): Promise<Omit<HarnessTurnResult, "attempts">> {
  const state: StreamState = { current: "", lastText: "", stopReason: "none", toolUses: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  for await (const event of stream) {
    const failure = streamFailure(event);
    if (failure !== undefined) throw failure;
    absorb(state, event);
  }
  if (state.current.trim() !== "" && state.lastText === "") state.lastText = state.current;
  return {
    outcome: outcomeOf(state.stopReason),
    stopReason: state.stopReason,
    note: [...state.lastText.trim()].slice(0, TURN_NOTE_MAX_CHARS).join(""),
    usage: state.usage,
    toolUses: state.toolUses,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHarnessClient(deps: HarnessClientDeps): HarnessClient {
  const sleep = deps.sleep ?? defaultSleep;
  return {
    async invoke(request) {
      const link = HarnessLink.parse(deps.link());
      const input = harnessRequest(link, request);
      const attemptBudgetMs = link.timeoutSeconds * 1_000 + HARNESS_ATTEMPT_GRACE_MS;
      for (let attempt = 0; ; attempt += 1) {
        const remaining = request.deadlineMs - deps.nowMs();
        if (remaining <= 0) throw new HarnessError("TIMEOUT", "no time left for the turn");
        try {
          const result = await withDeadline("InvokeHarness", Math.min(remaining, attemptBudgetMs), async (signal) => {
            const output = await deps.send(input, { abortSignal: signal });
            if (output.stream === undefined) throw new HarnessError("STREAM", "the Harness answered without a stream");
            return readHarnessStream(output.stream);
          });
          return { ...result, attempts: attempt + 1 };
        } catch (error) {
          if (error instanceof HarnessError) throw error;
          if (error instanceof DeadlineError) throw new HarnessError("TIMEOUT", "the turn ran past its deadline", { cause: error });
          if (!isThrottling(error)) throw new HarnessError("REQUEST", "InvokeHarness failed", { cause: error });
          const delay = backoffDelayMs(attempt, { ...HARNESS_BACKOFF, ...(deps.random === undefined ? {} : { random: deps.random }) });
          // A retry needs a whole attempt after the backoff; otherwise the event goes back to the queue.
          const roomLeft = request.deadlineMs - deps.nowMs() - delay >= attemptBudgetMs;
          if (attempt >= HARNESS_THROTTLE_RETRIES || !roomLeft) throw new HarnessError("THROTTLED", `InvokeHarness throttled after ${attempt + 1} attempts`, { cause: error });
          await sleep(delay);
        }
      }
    },
  };
}

let sdkClient: BedrockAgentCoreClient | undefined;

/** The SDK's own retries are off: throttling is retried above, within the turn's deadline. */
export function agentCoreClient(link: Pick<HarnessLink, "timeoutSeconds">): BedrockAgentCoreClient {
  sdkClient ??= new BedrockAgentCoreClient({
    region: REGION,
    ...awsClientConfig({ requestTimeoutMs: link.timeoutSeconds * 1_000 + HARNESS_ATTEMPT_GRACE_MS, connectionTimeoutMs: 2_000, maxAttempts: 1 }),
  });
  return sdkClient;
}

/** `Resource.Harness`, validated. */
export function linkedHarness(): HarnessLink {
  return readLinked("Harness", HarnessLink);
}

/** The Harness client of the event workers, over `Resource.Harness`. */
export function linkedHarnessClient(nowMs: () => number = () => Date.now()): HarnessClient {
  return createHarnessClient({
    link: linkedHarness,
    nowMs,
    send: (input, options) => agentCoreClient(linkedHarness()).send(new InvokeHarnessCommand(input), { abortSignal: options.abortSignal }),
  });
}
