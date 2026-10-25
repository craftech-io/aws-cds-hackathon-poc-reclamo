// What the tape view derives from `tape.list`, as pure functions: the filter it sends, how a sender
// and a decision read, the red banner of a block with its English gloss (the BFF's own `tapeBanner`,
// docs/design-brief.md §13) and the reroute of an entry. Typed against the real `AppRouter`.
import { type Channel, type TapeEntryKind, formatSimInstant } from "@reclamo/shared";
import { REROUTE_LABEL, tapeBanner } from "@reclamo/bff/copy/block-reasons";
import { REROUTE_GLOSS } from "@reclamo/bff/copy/en-gloss";
import { MESSAGE_KIND_LABEL } from "@reclamo/bff/copy/es-AR";
import { BlockSource, type Glossed } from "@reclamo/bff/copy/types";
import type { TapeRowEntry } from "../../components/TapeRow";
import type { RouterInputs, RouterOutputs } from "../../lib/trpc-router";
import { tapeCopy } from "./copy";

export type TapeList = RouterOutputs["tape"]["list"];
export type TapeItem = TapeList["entries"][number];
export type TapeListInput = NonNullable<RouterInputs["tape"]["list"]>;

export type SenderClass = "AGENT" | "SYSTEM" | "OPERATOR";
export const ALL = "ALL";
export type All = typeof ALL;

export interface TapeFilterState {
  readonly decision: TapeEntryKind | All;
  readonly sender: SenderClass | All;
  readonly channel: Channel | All;
  readonly ruleId: BlockSource | All;
  /** From `?complaint=` (a link from a complaint): only that complaint's decisions. */
  readonly complaintId?: string;
}

export const NO_FILTER: TapeFilterState = { decision: ALL, sender: ALL, channel: ALL, ruleId: ALL };

/** The first page, then 100 more at a time. */
export const PAGE = 100;

/** The input of `tape.list` for a filter: only what is set. */
export function listInputOf(filter: TapeFilterState, limit: number = PAGE): TapeListInput {
  return {
    ...(filter.decision !== ALL ? { decision: filter.decision } : {}),
    ...(filter.sender !== ALL ? { sender: filter.sender } : {}),
    ...(filter.channel !== ALL ? { channel: filter.channel } : {}),
    ...(filter.ruleId !== ALL ? { ruleId: filter.ruleId } : {}),
    ...(filter.complaintId !== undefined ? { complaintId: filter.complaintId } : {}),
    limit,
  };
}

/** The rules a person can filter by: every `CH-*` rule, G2 and the deterministic check. */
export const RULE_OPTIONS: readonly BlockSource[] = BlockSource.options;

export function senderClassOf(sender: string): SenderClass {
  return sender === "AGENT" || sender === "SYSTEM" ? sender : "OPERATOR";
}

/** "Agente · Agent", "Sistema · System" or "Persona del equipo · stf-operator-01" (a staff id, never a name or an email). */
export function senderText(sender: string): string {
  const senderClass = senderClassOf(sender);
  if (senderClass !== "OPERATOR") return tapeCopy.senders[senderClass];
  return `${tapeCopy.senders.OPERATOR} · ${sender.slice(sender.indexOf(":") + 1)}`;
}

/** The rule that decided a non-allowed entry, when it is one the console can name. */
export function blockSourceOf(entry: Pick<TapeItem, "ruleIds">): BlockSource | undefined {
  for (const ruleId of entry.ruleIds) {
    const parsed = BlockSource.safeParse(ruleId);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * The banner of a decision that is not a plain pass: "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION ·
 * Política comercial de WhatsApp (cobro de deudas)" with its English half; none for `ALLOWED` and
 * `DISPATCH`.
 */
export function bannerOf(entry: Pick<TapeItem, "decision" | "ruleIds">): Glossed | undefined {
  if (entry.decision === "ALLOWED" || entry.decision === "DISPATCH") return undefined;
  return tapeBanner(entry.decision, entry.decision === "REROUTED" ? undefined : blockSourceOf(entry));
}

export function rerouteText(route: keyof typeof REROUTE_LABEL): Glossed {
  return { es: REROUTE_LABEL[route], en: REROUTE_GLOSS[route] };
}

/** One row of the shared TapeRow: the rules only where they decided something (an allowed entry passed them all). */
export function rowOf(entry: TapeItem): TapeRowEntry {
  return {
    decision: entry.decision,
    sender: senderText(entry.sender),
    channel: entry.channel,
    kind: MESSAGE_KIND_LABEL[entry.kind],
    ruleIds: entry.decision === "ALLOWED" || entry.decision === "DISPATCH" ? [] : entry.ruleIds,
    atText: formatSimInstant(entry.atSim),
  };
}

/** The rules of an entry that did not simply pass, first; then the ones that passed or did not apply. */
export function reviewedRules(entry: Pick<TapeItem, "evaluated">): readonly { readonly ruleId: string; readonly result: string; readonly text: string }[] {
  const rank = (result: string) => (result === "PASS" || result === "SKIP" ? 1 : 0);
  return [...entry.evaluated]
    .sort((a, b) => rank(a.result) - rank(b.result))
    .map((rule) => ({ ruleId: rule.ruleId, result: rule.result, text: tapeCopy.ruleResults[rule.result] ?? rule.result }));
}

/** The filter of a `?complaint=` link, when it looks like an id. */
export function complaintFilterOf(search: URLSearchParams): string | undefined {
  const value = search.get("complaint");
  return value !== null && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : undefined;
}
