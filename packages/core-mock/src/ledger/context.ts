// What every ledger operation receives and how it fails. The ledger decides (ADR-0005): amounts,
// eligibility and claims are computed here from the core's own rows; the caller only names what it
// wants and its cap.
//
// Time: `simNow` is the world's simulated instant that the caller read from its clock and sent in
// `X-Sim-Now` (docs/architecture-integrations.md §5). The core never reads a clock (ADR-0011).
import { createHash } from "node:crypto";
import type { ContractErrorCode } from "@reclamo/core-contract";
import type { CoreStore } from "../store/port";

export interface LedgerContext {
  readonly store: CoreStore;
  readonly worldId: string;
  /** The world's simulated instant (`X-Sim-Now`). */
  readonly simNow: string;
  /**
   * HMAC of a normalized email with the `email-hash` subkey of `PhoneHashKey`; absent in tests that
   * do not exercise it. A new email is stored masked and hashed, never in clear.
   */
  readonly hashEmail?: (email: string) => string;
}

/** A refusal of the core with its contract code (docs/architecture-integrations.md §5). */
export class LedgerError extends Error {
  override readonly name = "LedgerError";
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    /** Only with `CONFLICT` on a money route: the action that already took the claim. */
    readonly actionId?: string,
  ) {
    super(message);
  }
}

/**
 * A deterministic id: the same inputs always give the same id, so a retried write lands on the same
 * key and its `absent` condition makes it a no-op instead of a second row.
 */
export function deterministicId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
}

/** Days of the regulatory and accounting rules are counted in Argentina, always UTC−03:00. */
const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

/** Local Argentine calendar date of an instant. */
export function localDate(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`not an instant: ${instant}`);
  return new Date(ms + AR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to` (`YYYY-MM-DD`), negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function instantMs(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`not an instant: ${instant}`);
  return ms;
}

/** Integer centavos of `base × rate`, rounded half away from zero. */
export function centsOf(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Code-point order, the same on every runtime (no locale collation). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
