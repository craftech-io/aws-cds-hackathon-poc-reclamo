// The trail of one message a person sent from the console (FL-064, FL-065, FL-066, FL-067, FL-085):
// the console only ENQUEUES it, the worker runs it through the gate, so the view reads the compliance
// tape until the decision is there. The trail starts at the entries of the message and follows its
// reroute: `REROUTED` (same message, `rerouteOf` the block) and the child request of a formal email
// (its own message, `rerouteOf` the block) with its dispatch. Pure, unit-tested without React.
import { type Reroute, formatSimInstant } from "@reclamo/shared";
import { BlockSource, tapeBanner } from "@reclamo/bff/copy/index";
import { reroutesFor } from "@reclamo/bff/channel-policy/reroutes";
import { senderClassOf } from "@reclamo/bff/channel-policy/kinds";
import type { PolicyContext } from "@reclamo/bff/channel-policy/context";
import type { ChannelRuleId } from "@reclamo/bff/copy/types";
import type { RouterOutputs } from "../../lib/trpc-router";

export type TapeListAnswer = RouterOutputs["tape"]["list"];
export type TapeEntryView = TapeListAnswer["entries"][number];

/** Entries of the trail of `messageId`, oldest first. */
export function trailOf(entries: readonly TapeEntryView[], messageId: string): TapeEntryView[] {
  const messages = new Set([messageId]);
  const blocks = new Set<string>();
  let size = -1;
  let trail: TapeEntryView[] = [];
  // Grows until nothing new joins: a block brings its reroute, a reroute brings its child's entries.
  while (trail.length !== size) {
    size = trail.length;
    trail = entries.filter((entry) => (entry.messageId !== undefined && messages.has(entry.messageId)) || (entry.rerouteOf !== undefined && blocks.has(entry.rerouteOf)));
    for (const entry of trail) {
      if (entry.decision === "BLOCKED" && entry.messageId !== undefined && messages.has(entry.messageId) && entry.rerouteOf === undefined) blocks.add(entry.tapeId);
      if (entry.messageId !== undefined) messages.add(entry.messageId);
    }
  }
  return [...trail].sort((a, b) => a.seq - b.seq);
}

/** The block of the trail that a person may still reroute (none once a `REROUTED` answers it). */
export function openBlockOf(trail: readonly TapeEntryView[]): TapeEntryView | undefined {
  return trail.find((entry) => entry.decision === "BLOCKED" && entry.rerouteOf === undefined && !trail.some((other) => other.decision === "REROUTED" && other.rerouteOf === entry.tapeId));
}

export type TrailStatus = "WAITING" | "NEEDS_CHOICE" | "SETTLED";

/**
 * Whether the view keeps reading the tape: an open block waits for the person; a deferral or a block
 * of the child ends it; an allowed message ends with its dispatch; a reroute to the human queue ends it.
 */
export function trailStatus(trail: readonly TapeEntryView[]): TrailStatus {
  if (trail.length === 0) return "WAITING";
  if (openBlockOf(trail) !== undefined) return "NEEDS_CHOICE";
  const last = trail[trail.length - 1];
  if (last === undefined) return "WAITING";
  if (last.decision === "DISPATCH" || last.decision === "DEFERRED" || last.decision === "BLOCKED") return "SETTLED";
  if (last.decision === "REROUTED") return last.reroute?.route === "HUMAN_QUEUE" ? "SETTLED" : "WAITING";
  return "WAITING";
}

/** The routes a block offers, from the policy's own table (channel-policy/reroutes.ts). */
export function offeredRoutes(entry: Pick<TapeEntryView, "ruleIds" | "kind" | "complaintId" | "rerouteOf" | "sender">): Reroute[] {
  const ruleId = entry.ruleIds[0];
  if (ruleId === undefined) return [];
  // reroutesFor reads only these fields of the context.
  const context = { request: { kind: entry.kind, complaintId: entry.complaintId, rerouteOf: entry.rerouteOf }, senderClass: senderClassOf(entry.sender) } as unknown as PolicyContext;
  return (reroutesFor(ruleId as ChannelRuleId, context) ?? []).map((option) => option.route);
}

export interface Banner {
  readonly es: string;
  readonly en: string;
  readonly tone: "danger" | "warning" | "success" | "info" | "neutral";
}

const TONES = { BLOCKED: "danger", REROUTED: "warning", ALLOWED: "success", DEFERRED: "info", DISPATCH: "neutral" } as const;

/** "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION · Política comercial de WhatsApp (cobro de deudas)", with its English line. */
export function bannerOf(entry: Pick<TapeEntryView, "decision" | "ruleIds">): Banner {
  const source = entry.decision === "BLOCKED" || entry.decision === "DEFERRED" ? BlockSource.safeParse(entry.ruleIds[0]) : undefined;
  return { ...tapeBanner(entry.decision, source?.success ? source.data : undefined), tone: TONES[entry.decision] };
}

/** The tape's simulated time as the console shows it. */
export function atText(entry: Pick<TapeEntryView, "atSim">): string {
  return formatSimInstant(entry.atSim);
}
