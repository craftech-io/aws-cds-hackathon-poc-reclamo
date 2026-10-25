// What the register view and the tape view derive from the BFF answers, as pure functions: the
// headline of a chain verification (docs/architecture.md §8.3: "Verificada" · "Parcial: N entradas
// sin ancla" · "Rota en seq N"), the page window of the entries and the check of a typed complaint
// number. The answers are typed against the real `AppRouter`, so a change in the router breaks here.
import { ComplaintNumber, formatPesos, formatSimInstant } from "@reclamo/shared";
import { COMPLAINT_STATUS_LABEL, COMPLAINT_TYPE_LABEL } from "@reclamo/bff/copy/es-AR";
import { beyondLabel, capitalize } from "@reclamo/bff/copy/helpers";
import type { RouterOutputs } from "../../lib/trpc-router";
import { registerCopy } from "./copy";

export type Verification = RouterOutputs["register"]["verify"];
export type ChainExportResult = RouterOutputs["register"]["export"];
export type RegisterPage = RouterOutputs["register"]["list"];
export type RegisterChain = RegisterPage["chain"];

export type VerificationTone = "success" | "warning" | "danger";

export interface VerificationHeadline {
  readonly text: string;
  readonly gloss: string;
  readonly tone: VerificationTone;
}

type VerificationLike = Pick<Verification, "result" | "brokenAt" | "unanchored" | "anchorConflicts">;

/** The `seq` a broken chain is reported at: `brokenAt`, or the first anchor conflict. */
export function brokenSeqOf(verification: VerificationLike): number | undefined {
  if (verification.brokenAt !== null) return verification.brokenAt;
  return verification.anchorConflicts[0];
}

/** The headline of a verification, worded as the export header says it. */
export function verificationHeadline(verification: VerificationLike): VerificationHeadline {
  const copy = registerCopy.status;
  if (verification.result === "ok") return { text: copy.ok, gloss: copy.okGloss, tone: "success" };
  if (verification.result === "partial") {
    const count = verification.unanchored.length;
    return { text: copy.partial(count), gloss: copy.partialGloss(count), tone: "warning" };
  }
  const seq = brokenSeqOf(verification);
  return seq === undefined ? { text: copy.brokenNoSeq, gloss: "Broken", tone: "danger" } : { text: copy.broken(seq), gloss: copy.brokenGloss(seq), tone: "danger" };
}

/** At most this many `seq` are listed by number; the rest is a count. */
const LISTED_SEQS = 12;

export function seqList(seqs: readonly number[]): string {
  if (seqs.length === 0) return "—";
  const shown = seqs.slice(0, LISTED_SEQS).join(", ");
  return seqs.length > LISTED_SEQS ? `${shown} (+${seqs.length - LISTED_SEQS})` : shown;
}

/** First characters of a hash, enough to compare by eye; the full hash goes in the title. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

export const PAGE_SIZE = 100;

/** The first `seq` of the page that ends at the newest entry (the view opens on the latest entries). */
export function latestPageStart(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, total - size + 1);
}

export interface PageWindow {
  readonly from: number;
  readonly to: number;
  readonly earlier: number | undefined;
  readonly later: number | undefined;
}

/** The window shown from `fromSeq` over a chain of `total` entries, and where the arrows go. */
export function pageWindow(fromSeq: number, total: number, size: number = PAGE_SIZE): PageWindow {
  const from = Math.min(Math.max(1, fromSeq), Math.max(1, total));
  const to = Math.min(total, from + size - 1);
  return {
    from,
    to,
    earlier: from > 1 ? Math.max(1, from - size) : undefined,
    later: to < total ? to + 1 : undefined,
  };
}

/** A typed complaint number, trimmed and upper-cased, or `undefined` when it is not one. */
export function complaintNumberOf(typed: string): string | undefined {
  const parsed = ComplaintNumber.safeParse(typed.trim().toUpperCase());
  return parsed.success ? parsed.data : undefined;
}

export type RegisterRow = Extract<RegisterPage["entries"][number], { eventType: unknown }>;
export type RefundRow = Extract<RegisterPage["entries"][number], { cause: unknown }>;

export function isRegisterRow(entry: RegisterPage["entries"][number]): entry is RegisterRow {
  return "eventType" in entry;
}

export function isRefundRow(entry: RegisterPage["entries"][number]): entry is RefundRow {
  return "cause" in entry;
}

/** One line of what an entry of the complaint register says. */
export function registerDetail(entry: RegisterRow): string {
  const parts = [`${registerCopy.kinds[entry.kind] ?? entry.kind} · ${capitalize(COMPLAINT_TYPE_LABEL[entry.type])}`];
  if (entry.status !== undefined) parts.push(COMPLAINT_STATUS_LABEL[entry.status]);
  const reason = entry.eventType === "FILED" ? beyondLabel(COMPLAINT_TYPE_LABEL[entry.type], entry.reason) : undefined;
  if (reason !== undefined) parts.push(reason);
  if (entry.presenter !== undefined) parts.push(`${registerCopy.presenter}: ${entry.presenter.docType} ${entry.presenter.docNumberMasked}`);
  return parts.join(" · ");
}

export function amountText(cents: number): string {
  return formatPesos(cents);
}

export function simText(instant: string): string {
  return formatSimInstant(instant);
}
