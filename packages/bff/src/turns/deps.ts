// What a turn needs and what it ends in. The Lambda entry builds the real dependencies
// (worker/production.ts); the unit tests and the local flows build them over the in-memory connector, a
// scripted Harness, a scripted G1 and the targets in process.
import type { HarnessClient, TokenUsage } from "../agent/harness-client";
import type { MemoryRetriever } from "../agent/memory";
import type { Connector } from "../connector/port";
import type { SecretKey } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { TurnInbound } from "./facts";
import type { G1Policy, G1Prefilter } from "./prefilter";
import type { TurnReads } from "./preload";
import type { AgentMode } from "./record";

export interface TurnDeps {
  readonly data: Connector;
  readonly harness: HarnessClient;
  readonly prefilter: G1Prefilter;
  readonly memory: MemoryRetriever;
  /** The `identity` and `account` targets in process: the reads the worker runs before the Harness. */
  readonly reads?: TurnReads;
  /** `SessionKey`: its `session` subkey signs the tokens, its `runtime-session` subkey the Harness session. */
  readonly sessionKey: () => SecretKey;
  /** `REAL` in the stage, `SCRIPTED` in the local flows. */
  readonly agentMode: AgentMode;
  /** Injected for tests: turn delimiters and ids. */
  readonly random?: (size: number) => Uint8Array;
}

export interface TurnContext {
  readonly log: Logger;
  /** Real time; the simulated "now" of every rule is the event's `eventAtSim`. */
  readonly now: () => Date;
  /** Real instant (epoch ms) the Harness must be done by. */
  readonly deadlineMs: number;
}

export type TurnFailureCause = "HARNESS_ERROR" | "TIMEOUT" | "INCOMPLETE" | "FORCED";

/** Where a block came from: G1 before the Harness, or the Harness's own guardrail. */
export type BlockOrigin = "PREFILTER" | "HARNESS";

export type TurnOutcome =
  | { readonly kind: "SKIPPED"; readonly reason: "NO_CONVERSATION" }
  | { readonly kind: "BLOCKED"; readonly origin: BlockOrigin; readonly policy: G1Policy | "HARNESS"; readonly topics: readonly string[]; readonly turnId?: string; readonly inbound?: TurnInbound; readonly stopReason?: string }
  | { readonly kind: "COMPLETED"; readonly turnId: string; readonly usage: TokenUsage; readonly stopReason: string; readonly toolUses: number; readonly complaintIds: readonly string[]; readonly forcedSilent?: boolean }
  | { readonly kind: "FAILED"; readonly turnId: string; readonly cause: TurnFailureCause; readonly stopReason?: string; readonly complaintIds: readonly string[] };
