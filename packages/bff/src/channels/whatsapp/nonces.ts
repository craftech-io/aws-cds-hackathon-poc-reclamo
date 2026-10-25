// Button nonces (docs/architecture-integrations.md §4 step 2, docs/architecture.md §13 "Varios
// préstamos", FL-005): every button a message carries is an opaque random nonce
// (`Runtime/W#<w>#NONCE#<nonce>`, seven real days) bound to the customer's phone hash, the customer
// and, when it is about one, the complaint or the loan. The model and the customer only ever see the
// nonce; what it means lives here. Nonces are random and use no key (docs/architecture.md §3).
//
// Resolution refuses (the caller audits `DENY NONCE_*` and reads the button's title as free text):
//   NONCE_UNKNOWN   no such nonce in this world (never issued, gone, or another world's)
//   NONCE_EXPIRED   past its seven real days
//   NONCE_FOREIGN   issued to another phone or another customer
//   NONCE_USED      a one-shot action already taken (an email consent, a closure, a withdrawal)
import { ConnectorError, type WaButtonAction } from "@reclamo/shared";
import type { Nonce } from "../../domain/runtime-claims";
import type { Connector } from "../../connector/port";
import type { WriteOp } from "../../connector/store";
import { newNonce } from "../../lib/crypto";
import { NONCE_TTL_MS } from "./config";
import { ReplyId } from "./meta-message";

export const NONCE_REFUSALS = ["NONCE_UNKNOWN", "NONCE_EXPIRED", "NONCE_FOREIGN", "NONCE_USED"] as const;
export type NonceRefusal = (typeof NONCE_REFUSALS)[number];

/** Actions whose effect happens once: a second tap is refused instead of repeating it. */
export const ONE_SHOT_ACTIONS: ReadonlySet<WaButtonAction> = new Set<WaButtonAction>(["ACCEPT_EMAIL", "DECLINE_EMAIL", "CONFIRM_CLOSURE", "WITHDRAW"]);

export interface ButtonToIssue {
  readonly action: WaButtonAction;
  readonly complaintId?: string;
  /** A row of the loan list stands for its loan (`CHOOSE_LOAN`). */
  readonly loanId?: string;
}

export interface IssueNoncesInput {
  readonly worldId: string;
  readonly customerId: string;
  readonly phoneHash: string;
  /** The message that carries the buttons. */
  readonly messageId: string;
  readonly buttons: readonly ButtonToIssue[];
  /** Real time: a nonce lives seven real days. */
  readonly now: Date;
  /** Test seam. */
  readonly generate?: (nowMs: number) => string;
}

/** One `NONCE#` per button, as operations to commit with the message; answers the nonces in order. */
export function nonceOps(data: Pick<Connector, "claims">, input: IssueNoncesInput): { readonly nonces: string[]; readonly ops: WriteOp[] } {
  const generate = input.generate ?? newNonce;
  const nonces: string[] = [];
  const ops: WriteOp[] = [];
  for (const button of input.buttons) {
    if (button.action === "CHOOSE_LOAN" && button.loanId === undefined) throw new RangeError("a CHOOSE_LOAN row needs its loan");
    const nonce = generate(input.now.getTime());
    nonces.push(nonce);
    ops.push(
      data.claims.putNonceOp({
        worldId: input.worldId,
        nonce,
        action: button.action,
        phoneHash: input.phoneHash,
        customerId: input.customerId,
        messageId: input.messageId,
        createdAtReal: input.now.toISOString(),
        ...(button.complaintId === undefined ? {} : { complaintId: button.complaintId }),
        ...(button.loanId === undefined ? {} : { loanId: button.loanId }),
      }),
    );
  }
  return { nonces, ops };
}

/** Writes the nonces of a message's buttons (in one transaction) and answers them in order. */
export async function issueNonces(data: Pick<Connector, "claims" | "transact">, input: IssueNoncesInput): Promise<string[]> {
  const { nonces, ops } = nonceOps(data, input);
  if (ops.length > 0) await data.transact(ops);
  return nonces;
}

export interface ResolveNonceInput {
  readonly worldId: string;
  readonly value: string;
  readonly phoneHash: string;
  readonly customerId: string;
  readonly now: Date;
}

export type NonceResolution = { readonly ok: true; readonly nonce: Nonce } | { readonly ok: false; readonly reason: NonceRefusal; readonly nonce?: Nonce };

const refuse = (reason: NonceRefusal, nonce?: Nonce): NonceResolution => (nonce === undefined ? { ok: false, reason } : { ok: false, reason, nonce });

/** What a tapped button means, or why it means nothing. Never consumes the nonce (see `consumeNonce`). */
export async function resolveNonce(data: Pick<Connector, "claims">, input: ResolveNonceInput): Promise<NonceResolution> {
  if (!ReplyId.safeParse(input.value).success) return refuse("NONCE_UNKNOWN");
  const nonce = await data.claims.getNonce(input.worldId, input.value);
  if (nonce === undefined) return refuse("NONCE_UNKNOWN");
  if (Date.parse(nonce.createdAtReal) + NONCE_TTL_MS <= input.now.getTime()) return refuse("NONCE_EXPIRED", nonce);
  if (nonce.phoneHash !== input.phoneHash || nonce.customerId !== input.customerId) return refuse("NONCE_FOREIGN", nonce);
  if (ONE_SHOT_ACTIONS.has(nonce.action) && nonce.usedAtReal !== undefined) return refuse("NONCE_USED", nonce);
  return { ok: true, nonce };
}

/**
 * Marks a one-shot nonce used once its effect is done; `false` when a concurrent tap used it first
 * (the caller then does nothing more). Repeatable actions are never marked.
 */
export async function consumeNonce(data: Pick<Connector, "claims" | "write">, nonce: Nonce): Promise<boolean> {
  if (!ONE_SHOT_ACTIONS.has(nonce.action)) return true;
  try {
    await data.write(data.claims.consumeNonceOp(nonce.worldId, nonce.nonce));
    return true;
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
    throw error;
  }
}
