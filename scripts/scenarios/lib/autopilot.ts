// The cliente autopiloto (docs/test-plan.md §4.3): the customer's replies are not a fixed list in order;
// the autopilot reads the persisted state and answers what is pending, the way a person on the phone would:
//
//   IDENTITY_CHALLENGE pending   the kind it asks (date, instalment amount, wallet movement), with the truth
//                                of the persona's model (lib/personas.ts), or a wrong value when the step
//                                proves two failures (FL-004)
//   RECEIPT_REQUEST pending      the scenario's next receipt variant, if it declared one
//   a button the step declares   tapped once when the last message offering it is there (`ACCEPT_EMAIL`,
//                                `CHOOSE_LOAN`, `CONFIRM_CLOSURE`…); the driver resolves the nonce
//   nothing pending              no message at all
//
// The only "second turn" a step admits is the obligation the code enqueues (`ANSWER_DUE`, `RECONCILE_DUE`),
// never an extra message from the customer nor a retry of the scenario: the autopilot never writes twice
// to the same request and never writes without one. `nextMove` is pure; `drive` runs it against the stage.
import type { WaButtonAction } from "@reclamo/shared";
import { DriverRefusal, type QaInput, type ScenarioContext } from "./steps";
import { type ChallengeKind, type PersonaTruth, challengeAnswer, truthOf, wrongAnswer } from "./personas";
import type { Snapshot, SnapshotMessage } from "./snapshot";

type WaContent = QaInput<"wa.inbound">["content"];

export interface AutopilotPlan {
  /** Clone key of the persona in the QA world (`a`). */
  readonly persona: string;
  /** Its model (`C01`): whose truth answers the challenge. */
  readonly model: string;
  /** Buttons to tap, each once, when a message offers it. */
  readonly buttons?: readonly WaButtonAction[];
  /** Receipts sent, in order, each answering one pending `RECEIPT_REQUEST`. */
  readonly receipts?: readonly WaContent[];
  /** `WRONG` proves the two failures of FL-004; `TRUTH` by default. */
  readonly challenge?: "TRUTH" | "WRONG";
}

export interface AutopilotProgress {
  readonly answered: Set<string>;
  readonly tapped: Set<WaButtonAction>;
  /** Buttons the driver said no message offers yet, per snapshot epoch of messages (count of messages). */
  readonly notOffered: Map<WaButtonAction, number>;
  receiptsSent: number;
}

export const newProgress = (): AutopilotProgress => ({ answered: new Set(), tapped: new Set(), notOffered: new Map(), receiptsSent: 0 });

export type Move =
  | { readonly kind: "challenge"; readonly messageId: string; readonly challenge: ChallengeKind; readonly content: WaContent }
  | { readonly kind: "receipt"; readonly messageId: string; readonly content: WaContent }
  | { readonly kind: "button"; readonly action: WaButtonAction; readonly content: WaContent };

/** The kind of challenge an outbound text asks for (the copy's prompts, or the agent's words around them). */
export function challengeKindOf(body: string): ChallengeKind | undefined {
  const text = body.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/movimiento/.test(text)) return "LAST_MOVEMENT_AMOUNT";
  if (/fecha|venc/.test(text)) return "LAST_DUE_DATE";
  if (/importe|monto|cuanto/.test(text)) return "LAST_INSTALMENT_AMOUNT";
  return undefined;
}

/** The last outbound message of `kind` that no inbound message followed yet. */
export function pendingOutbound(snapshot: Snapshot, kind: SnapshotMessage["kind"]): SnapshotMessage | undefined {
  const all = snapshot.messages;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index];
    if (message === undefined) continue;
    if (message.direction === "IN") return undefined;
    if (message.kind === kind) return message;
  }
  return undefined;
}

/** The simulated now of a paused world (the moment the challenge is asked about). */
export function simNowOf(snapshot: Snapshot): string {
  return snapshot.clock.pausedSimNow ?? new Date().toISOString();
}

/** What the customer does now, given the persisted state; `undefined` when nothing waits for them. */
export function nextMove(snapshot: Snapshot, plan: AutopilotPlan, progress: AutopilotProgress, truth: PersonaTruth = truthOf(plan.model)): Move | undefined {
  const challenge = pendingOutbound(snapshot, "IDENTITY_CHALLENGE");
  if (challenge !== undefined && !progress.answered.has(challenge.messageId)) {
    const kind = challengeKindOf(challenge.body);
    if (kind !== undefined) {
      const right = challengeAnswer(truth, kind, simNowOf(snapshot));
      const text = plan.challenge === "WRONG" || right === undefined ? wrongAnswer(kind) : right;
      return { kind: "challenge", messageId: challenge.messageId, challenge: kind, content: { type: "text", text } };
    }
  }
  const request = pendingOutbound(snapshot, "RECEIPT_REQUEST");
  const receipt = plan.receipts?.[progress.receiptsSent];
  if (request !== undefined && receipt !== undefined && !progress.answered.has(request.messageId)) {
    return { kind: "receipt", messageId: request.messageId, content: receipt };
  }
  const outbound = snapshot.messages.filter((message) => message.direction === "OUT").length;
  for (const action of plan.buttons ?? []) {
    if (progress.tapped.has(action)) continue;
    // Asked again only after a new outbound message arrived since the driver said none offered it.
    if ((progress.notOffered.get(action) ?? -1) >= outbound) continue;
    return { kind: "button", action, content: { type: "button", action } };
  }
  return undefined;
}

/** Records a move the stage accepted (or a button no message offers yet). */
export function recordMove(progress: AutopilotProgress, move: Move, outcome: "SENT" | "NOT_OFFERED", outboundCount: number): void {
  if (move.kind === "button") {
    if (outcome === "SENT") progress.tapped.add(move.action);
    else progress.notOffered.set(move.action, outboundCount);
    return;
  }
  progress.answered.add(move.messageId);
  if (move.kind === "receipt") progress.receiptsSent += 1;
}

export interface DriveOptions {
  readonly worldId: string;
  readonly customerId: string;
  readonly plan: AutopilotPlan;
  readonly progress?: AutopilotProgress;
  /** What the step waits for, on a fresh snapshot. */
  readonly until: (snapshot: Snapshot) => boolean;
  readonly what: string;
  readonly timeoutSec: number;
}

/** Plays the customer until `until` holds: one move per pending request, never a message of its own. */
export async function drive(ctx: ScenarioContext, options: DriveOptions): Promise<Snapshot> {
  const progress = options.progress ?? newProgress();
  return ctx.eventually(
    `${options.what} (autopilot of ${options.plan.persona})`,
    async () => {
      const snapshot = await ctx.snapshot(options.worldId, options.customerId);
      if (options.until(snapshot)) return snapshot;
      const move = nextMove(snapshot, options.plan, progress);
      if (move === undefined) return undefined;
      const outbound = snapshot.messages.filter((message) => message.direction === "OUT").length;
      try {
        await ctx.qa("wa.inbound", { worldId: options.worldId, persona: options.plan.persona, content: move.content });
        recordMove(progress, move, "SENT", outbound);
        if (move.kind === "challenge") ctx.note(`challenge-${progress.answered.size}`, move.challenge);
      } catch (error) {
        if (!(error instanceof DriverRefusal) || error.reason !== "SIM_BUTTON_NOT_FOUND") throw error;
        recordMove(progress, move, "NOT_OFFERED", outbound);
      }
      return undefined;
    },
    options.timeoutSec,
    3,
  );
}
