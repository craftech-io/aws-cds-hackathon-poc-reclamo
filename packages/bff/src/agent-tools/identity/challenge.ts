// The identity challenge, decided by code (docs/design-brief.md §5, docs/tool-catalog.md target
// `identity`):
//
//   - which fact is asked: the due date of the last instalment already due; with no instalment due
//     yet, the amount of the last wallet movement (customers without loans). The amount of the last
//     instalment is never asked while an open complaint of the session has a receipt image: it is
//     printed on the receipt. The same customer state always gives the same question, so the answer
//     `verify_challenge` checks is the one `identify_customer` asked;
//   - failures are counted per customer over the last 24 REAL hours, whatever the session, complaint,
//     conversation epoch or world clock (`Runtime/W#<w>#CHALLENGE#<customerId>`); two of them lock the
//     challenge until a person lifts it (`customers.unlockChallenge`);
//   - a passed challenge identifies the customer for 30 REAL minutes (`identifiedUntilReal`).
//
// The expected value never leaves the core: it answers `{ok}` and nothing else.
import type { ChallengeKind } from "@reclamo/core-contract";
import type { Connector } from "../../connector/port";
import type { ChallengeLedger } from "../../domain/runtime-claims";
import type { ToolContext } from "../common/context";
import { type CorePort, coreContextOf } from "../account/core";
import { localDate, shiftDate } from "../account/format";

/** Failures in 24 real hours that lock the challenge (no third attempt by chat). */
export const MAX_CHALLENGE_FAILURES = 2;
export const CHALLENGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a passed challenge identifies the customer, on the real clock. */
export const IDENTIFICATION_MS = 30 * 60 * 1000;
/** How far back a wallet movement still makes `LAST_MOVEMENT_AMOUNT` answerable (the core's widest window). */
export const MOVEMENT_WINDOW_DAYS = 90;

/** Preference order of the facts asked. */
export const CHALLENGE_ORDER: readonly ChallengeKind[] = ["LAST_DUE_DATE", "LAST_INSTALMENT_AMOUNT", "LAST_MOVEMENT_AMOUNT"];

export interface ChallengeFacts {
  /** An instalment of any loan of the customer is already due at the world's today. */
  readonly instalmentDue: boolean;
  /** The wallet has a movement at or before the world's now. */
  readonly walletMovement: boolean;
  /** An open complaint of the session carries a receipt image. */
  readonly receiptAttached: boolean;
}

/** The fact to ask, or `undefined` when the customer can answer none (a person verifies them). */
export function challengeKindFor(facts: ChallengeFacts): ChallengeKind | undefined {
  return CHALLENGE_ORDER.find((kind) => {
    if (kind === "LAST_MOVEMENT_AMOUNT") return facts.walletMovement;
    if (kind === "LAST_INSTALMENT_AMOUNT" && facts.receiptAttached) return false;
    return facts.instalmentDue;
  });
}

export interface ChallengeStanding {
  /** Failures of the customer in the last 24 real hours. */
  readonly failures: number;
  readonly locked: boolean;
  readonly attemptsLeft: number;
}

/** Where a customer stands: a staff lock or two failures in 24 real hours lock it. */
export function standingOf(ledger: ChallengeLedger | undefined, realNow: Date): ChallengeStanding {
  const since = realNow.getTime() - CHALLENGE_WINDOW_MS;
  const failures = (ledger?.failures ?? []).filter((at) => Date.parse(at) > since).length;
  const locked = ledger?.lockedAtReal !== undefined || failures >= MAX_CHALLENGE_FAILURES;
  return { failures, locked, attemptsLeft: locked ? 0 : MAX_CHALLENGE_FAILURES - failures };
}

/** Reads, from the core and the session's complaints, what decides the question. */
export async function challengeFacts(core: CorePort, connector: Connector, ctx: ToolContext<unknown>): Promise<ChallengeFacts> {
  const call = coreContextOf(ctx);
  const { worldId, customerId, complaintIds } = ctx.session;
  const today = localDate(ctx.session.eventAtSim);
  const customer = await core().call("getCustomer", call, { params: { customerId } });
  const [instalments, movements, evidence] = await Promise.all([
    Promise.all(customer.loans.map((loan) => core().call("listInstalments", call, { params: { loanId: loan.loanId } }))),
    core().call("listOperations", call, { params: { customerId }, query: { from: shiftDate(today, -MOVEMENT_WINDOW_DAYS), to: today, kind: "ALL" } }),
    Promise.all(complaintIds.map((complaintId) => connector.caseItems.listEvidence(worldId, complaintId))),
  ]);
  return {
    instalmentDue: instalments.some((list) => list.instalments.some((instalment) => instalment.dueDate <= today)),
    walletMovement: movements.operations.length > 0,
    receiptAttached: evidence.flat().some((item) => item.kind === "RECEIPT_IMAGE"),
  };
}
