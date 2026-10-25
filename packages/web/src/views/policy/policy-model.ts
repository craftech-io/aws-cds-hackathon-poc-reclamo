// What the policy view derives from `policy.rules` and `policy.modes`, as pure functions: who sees the
// agent cut-off (a SUPERVISOR of the `demo` world; the BFF enforces the same row of the role matrix),
// the state of the cut and the world's parameters as labelled rows. Typed against the real `AppRouter`.
import { type CapAction, type StaffRole, formatPesos, formatSimInstant, worldKindOf } from "@reclamo/shared";
import type { RouterOutputs } from "../../lib/trpc-router";
import { policyCopy } from "./copy";

export type PolicyRules = RouterOutputs["policy"]["rules"];
export type PolicyModes = RouterOutputs["policy"]["modes"];
export type WorldParameters = NonNullable<PolicyRules["parameters"]>;

/** `policy.setAgentKill` is a SUPERVISOR's, and only in the `demo` world (routers/roles.ts). */
export function canCutAgent(principal: { readonly role?: StaffRole | undefined; readonly worldId?: string | undefined }): boolean {
  return principal.role === "SUPERVISOR" && principal.worldId !== undefined && worldKindOf(principal.worldId) === "DEMO";
}

export interface KillState {
  readonly cut: boolean;
  readonly text: string;
}

export function killStateOf(modes: Pick<PolicyModes, "agentKill">): KillState {
  const { global, world, since } = modes.agentKill;
  if (!global && !world) return { cut: false, text: policyCopy.kill.inactive };
  return { cut: true, text: since === null ? policyCopy.kill.active : policyCopy.kill.activeSince(formatSimInstant(since)) };
}

export interface ParameterRow {
  readonly label: string;
  readonly value: string;
  /** Our reading of a rule (docs/design-brief.md §7): shown as "supuesto". */
  readonly assumption?: boolean;
}

/** The world's parameters, in the order the rules use them. */
export function parameterRows(parameters: WorldParameters): ParameterRow[] {
  const p = policyCopy.parameters;
  const { contactHours } = parameters;
  return [
    { label: p.weekday, value: p.range(contactHours.weekday.from, contactHours.weekday.to), assumption: true },
    { label: p.saturday, value: contactHours.saturday === null ? p.noSaturday : p.range(contactHours.saturday.from, contactHours.saturday.to), assumption: true },
    { label: p.formalNotice, value: p.range(contactHours.formalNotice.from, contactHours.formalNotice.to), assumption: true },
    { label: p.maxPerDay, value: String(parameters.maxProactivePerDay), assumption: true },
    { label: p.ratePerHour, value: String(parameters.rateLimitPerHour) },
    { label: p.turnCaps, value: `${parameters.turnCaps.perHour} / ${parameters.turnCaps.perDay}` },
    { label: p.imageReads, value: String(parameters.imageReadsPerDay) },
    { label: p.autoActions, value: String(parameters.caps.autoActionsPer30Days) },
    { label: p.whatsappMode, value: parameters.channelModes.whatsapp === "live" ? policyCopy.modes.live : policyCopy.modes.simulated },
  ];
}

export interface CapLine {
  readonly action: string;
  readonly text: string;
}

/** "Imputar un pago: el agente hasta $ 50.000,00 · un operador hasta $ 200.000,00 · por encima, un supervisor". */
export function capLines(parameters: WorldParameters): CapLine[] {
  const p = policyCopy.parameters;
  return (Object.entries(parameters.caps.perAction) as [CapAction, { agentCents: number; operatorCents: number }][]).map(([action, limits]) => ({
    action: policyCopy.capActions[action],
    text: `${p.capAgent} ${formatPesos(limits.agentCents)} · ${p.capOperator} ${formatPesos(limits.operatorCents)} · ${p.capAbove}`,
  }));
}
