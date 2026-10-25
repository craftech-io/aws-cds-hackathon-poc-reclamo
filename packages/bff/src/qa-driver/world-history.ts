// The `history` of `world.create` (docs/tool-catalog.md, FL-040): earlier money actions of a cloned
// persona, written as the models write a persona's past. Each entry becomes one closed complaint of the
// persona, filed `daysAgo` simulated days before the world's start, with the action executed by the
// agent on its own (no approval) and its register entries (`FILED`, then the status changes), so the
// chain, the anchors and the complaint counter treat it as any historical complaint of the models.
//
//   complaint id   `cmp-qh-<key>-<n>`; number `R-<year>-<n>` above every number of the models
//   action         `act-qh-<key>-<n>`, `EXECUTED`, `actor AGENT`, no `approvalId`: what
//                  complaints/caps.ts counts in the last 30 simulated days
import { ToolError } from "@reclamo/shared";
import { isoAr } from "../complaints/sla";
import { EPOCH_TOKEN, WORLD_TOKEN } from "../worlds/template";
import type { HistoryEntry } from "./inputs";

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** The type of the complaint each action answers. */
const COMPLAINT_TYPE = { REVERSE_CHARGE: "UNRECOGNIZED_CHARGE", REFUND_DUPLICATE: "DUPLICATE_DEBIT", TRANSFER_REVERSAL: "TRANSFER_NOT_CREDITED" } as const;
const SUMMARY = { REVERSE_CHARGE: "Cargo no reconocido", REFUND_DUPLICATE: "Débito duplicado", TRANSFER_REVERSAL: "Transferencia no acreditada" } as const;

export interface HistoryRow {
  readonly table: "Complaints";
  readonly pk: string;
  readonly sk: string;
  readonly entity: "Complaint" | "Action";
  readonly data: Record<string, unknown>;
}

export interface HistoryPlan {
  readonly rows: readonly HistoryRow[];
  /** Register entries in the shape of the models' `registerEvents` (the factory sequences and chains them). */
  readonly events: readonly Record<string, unknown>[];
}

/** `R-<year>-<n>`: the highest number of a year, from register events. */
export function highestNumbers(events: readonly Record<string, unknown>[]): Map<string, number> {
  const highest = new Map<string, number>();
  for (const event of events) {
    const match = typeof event.complaintNumber === "string" ? /^R-(\d{4})-(\d{6})$/.exec(event.complaintNumber) : null;
    if (match?.[1] && match[2]) highest.set(match[1], Math.max(highest.get(match[1]) ?? 0, Number(match[2])));
  }
  return highest;
}

function at(startMs: number, daysAgo: number, minutes: number): { readonly sim: string; readonly real: string } {
  const instant = new Date(startMs - daysAgo * DAY_MS + minutes * MINUTE_MS);
  return { sim: isoAr(instant), real: instant.toISOString() };
}

function event(base: Record<string, unknown>, eventType: string, when: { readonly sim: string; readonly real: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, eventType, atSim: when.sim, atReal: when.real, ...extra };
}

/**
 * The rows and register entries of the history. `customerIdOf` maps a clone key to its customer id
 * (undefined for a key the request did not clone); `modelEvents` are every register event of the
 * models, so a history number never repeats one.
 */
export function historyPlan(input: {
  readonly history: readonly HistoryEntry[];
  readonly startAtSim: string;
  readonly customerIdOf: (key: string) => string | undefined;
  readonly modelEvents: readonly Record<string, unknown>[];
}): HistoryPlan {
  const startMs = Date.parse(input.startAtSim);
  if (Number.isNaN(startMs)) throw new ToolError("INVALID", "the models have no valid startAtSim");
  const highest = highestNumbers(input.modelEvents);
  const rows: HistoryRow[] = [];
  const events: Record<string, unknown>[] = [];
  // Numbered in filing order (the oldest first), as the register is.
  const ordered = [...input.history].sort((a, b) => b.daysAgo - a.daysAgo);
  ordered.forEach((entry, index) => {
    const customerId = input.customerIdOf(entry.persona);
    if (customerId === undefined) throw new ToolError("INVALID", `history names ${entry.persona}, which is not a requested persona`, "HISTORY_PERSONA");
    const n = index + 1;
    const filed = at(startMs, entry.daysAgo, -120);
    const investigating = at(startMs, entry.daysAgo, -117);
    const executed = at(startMs, entry.daysAgo, -60);
    const closed = at(startMs, entry.daysAgo, -30);
    const year = filed.sim.slice(0, 4);
    const number = (highest.get(year) ?? 0) + 1;
    highest.set(year, number);
    const complaintNumber = `R-${year}-${String(number).padStart(6, "0")}`;
    const complaintId = `cmp-qh-${entry.persona}-${n}`;
    const type = COMPLAINT_TYPE[entry.action];
    const pk = `W#${WORLD_TOKEN}#CMP#${complaintId}`;
    rows.push({
      table: "Complaints",
      pk,
      sk: "META",
      entity: "Complaint",
      data: {
        worldId: WORLD_TOKEN,
        complaintId,
        complaintNumber,
        epoch: EPOCH_TOKEN,
        customerId,
        kind: "RECLAMO",
        type,
        status: "CLOSED",
        outcome: "IN_FAVOUR",
        priority: "NORMAL",
        origin: "SEED",
        control: "AGENT",
        channel: "WHATSAPP",
        summary: SUMMARY[entry.action],
        filedAtSim: filed.sim,
        deadlineSim: isoAr(new Date(startMs - entry.daysAgo * DAY_MS + 14 * DAY_MS)),
        slaState: "ON_TIME",
        emailAnswerConsent: { status: "DECLINED", atSim: filed.sim, textVersion: "email-answer-v1" },
        statusHistory: [
          { from: null, to: "REGISTERED", atSim: filed.sim, cause: "FILED", actor: "SYSTEM" },
          { from: "REGISTERED", to: "INVESTIGATING", atSim: investigating.sim, cause: "IDENTIFIED", actor: "AGENT" },
          { from: "INVESTIGATING", to: "RESOLVED", atSim: executed.sim, cause: "RESOLVED", actor: "AGENT" },
          { from: "RESOLVED", to: "CLOSED", atSim: closed.sim, cause: "AUTO_CLOSE", actor: "SYSTEM" },
        ],
        version: 4,
        synthetic: true,
      },
    });
    rows.push({
      table: "Complaints",
      pk,
      sk: `ACT#act-qh-${entry.persona}-${n}`,
      entity: "Action",
      data: {
        worldId: WORLD_TOKEN,
        complaintId,
        actionId: `act-qh-${entry.persona}-${n}`,
        kind: entry.action,
        status: "EXECUTED",
        amountCents: entry.amountCents,
        idempotencyKey: `${complaintId}:${entry.action}:history`,
        atSim: executed.sim,
        actor: "AGENT",
        synthetic: true,
      },
    });
    const base = { worldId: WORLD_TOKEN, epoch: EPOCH_TOKEN, complaintId, complaintNumber, kind: "RECLAMO", type, channel: "WHATSAPP", origin: "SEED", synthetic: true };
    events.push(
      event(base, "FILED", filed, { reason: SUMMARY[entry.action].toLowerCase() }),
      event(base, "STATUS", investigating, { status: "INVESTIGATING" }),
      event(base, "STATUS", executed, { status: "RESOLVED" }),
      event(base, "STATUS", closed, { status: "CLOSED" }),
    );
  });
  return { rows, events };
}
