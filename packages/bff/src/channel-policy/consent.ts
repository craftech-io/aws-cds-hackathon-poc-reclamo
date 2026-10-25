// The customer's WhatsApp consent as the policy reads it: dated `OPT_IN` / `OPT_OUT` steps. The core
// (`GET /customers/{id}`, docs/architecture-integrations.md §5) answers the current state with the
// instants of the last opt-in and opt-out; this rebuilds the steps from it, so the gate (now) and
// `PolicyAudit` (at a past instant) read the same thing.
import type { ConsentEvent, PolicyInput } from "./types";

/** The `whatsapp` block of the core's `Customer`. */
export interface WhatsAppConsentState {
  readonly optedIn: boolean;
  readonly optedInAtSim?: string;
  readonly optInMedium?: string;
  readonly optInTextVersion?: string;
  readonly optedOut: boolean;
  readonly optedOutAtSim?: string;
}

/** The dated steps of a consent state, oldest first. */
export function consentHistoryOf(state: WhatsAppConsentState): ConsentEvent[] {
  const steps: ConsentEvent[] = [];
  if (state.optedInAtSim !== undefined) {
    steps.push({
      action: "OPT_IN",
      atSim: state.optedInAtSim,
      ...(state.optInMedium === undefined ? {} : { medium: state.optInMedium }),
      ...(state.optInTextVersion === undefined ? {} : { textVersion: state.optInTextVersion }),
    });
  }
  if (state.optedOutAtSim !== undefined) steps.push({ action: "OPT_OUT", atSim: state.optedOutAtSim });
  return steps.sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
}

/** The policy's `customer` from the core's consent state: dated steps plus the current flags. */
export function policyCustomerOf(customerId: string, state: WhatsAppConsentState): NonNullable<PolicyInput["customer"]> {
  return { customerId, consentHistory: consentHistoryOf(state), optedIn: state.optedIn, optedOut: state.optedOut };
}
