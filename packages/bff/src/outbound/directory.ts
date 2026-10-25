// The gate's view of a customer in a deployed function, over the lender core (core/client.ts):
//
//   customers   `GET /customers/{id}` (masked: first name, masked email, WhatsApp consent, loans)
//   debts       the first loan `IN_ARREARS` and its `OVERDUE` instalments with their outstanding amount:
//               the only source of a formal debt notice (FL-065)
//   emails      the synthetic mailbox of docs/seed-spec.md §5, rebuilt from the core's masked email:
//               the SES simulator's mailbox (`s`uccess, `b`ounce, `c`omplaint, `o`oto) and the label of
//               the world (`<customerId>` in `demo`, `<worldId>-<customerId>` in a guest or load world,
//               `qa-<runId>-<scenario>-<key>` in QA); anything else (a demo recipient) is not resolved
//   whatsapp    the synthetic number of a seed persona (`cus-00nn` → `+54911000010nn`, docs/seed-spec.md
//               §5) for the phone simulator; in `live`, the core's `liveE164` (`GET …/live-recipient`,
//               a route only the functions that run the gate may call) of a world the stage lets run
//               live; the gate's fence and the live transport then match it against the demo phones
import type { ChannelMode } from "@reclamo/shared";
import { worldKindOf } from "@reclamo/shared";
import { type ChannelModes, stageAllowsLiveWhatsApp } from "../lib/resource";
import { CoreError } from "../core/errors";
import type { CoreClient } from "../core/client";
import type { RecipientResolver } from "../channels/whatsapp/transport";
import type { CustomerFacts, CustomerReader, DebtDetail, DebtReader, EmailDirectory } from "./deps";

const SIMULATOR_DOMAIN = "simulator.amazonses.com";
const MAILBOX_BY_INITIAL: Readonly<Record<string, string>> = { s: "success", b: "bounce", c: "complaint", o: "ooto" };
const PERSONA = /^cus-00(\d{2})$/;

function notFound(error: unknown): boolean {
  return error instanceof CoreError && error.code === "NOT_FOUND";
}

export function coreCustomerReader(core: CoreClient): CustomerReader {
  return {
    async get(worldId, customerId, simNow, correlationId) {
      try {
        const customer = await core.call("getCustomer", { worldId, simNow: simNow.toISOString(), correlationId }, { params: { customerId } });
        return {
          customerId: customer.customerId,
          firstName: customer.firstName,
          emailMasked: customer.emailMasked,
          whatsapp: customer.whatsapp,
          loans: customer.loans.map((loan) => ({ loanId: loan.loanId, label: loan.label })),
        } satisfies CustomerFacts;
      } catch (error) {
        if (notFound(error)) return undefined;
        throw error;
      }
    },
  };
}

export function coreDebtReader(core: CoreClient): DebtReader {
  return {
    async overdue(worldId, customerId, simNow, correlationId): Promise<DebtDetail | undefined> {
      const ctx = { worldId, simNow: simNow.toISOString(), correlationId };
      const customer = await core.call("getCustomer", ctx, { params: { customerId } });
      const loan = customer.loans.find((candidate) => candidate.status === "IN_ARREARS");
      if (loan === undefined) return undefined;
      const list = await core.call("listInstalments", ctx, { params: { loanId: loan.loanId } });
      const overdue = list.instalments.filter((row) => row.status === "OVERDUE" && row.outstanding > 0).map((row) => ({ instalment: row.number, dueDate: row.dueDate, amountCents: row.outstanding }));
      if (overdue.length === 0 || list.customerId !== customerId) return undefined;
      return { loanId: loan.loanId, loanLabel: loan.label, overdue, totalCents: overdue.reduce((sum, row) => sum + row.amountCents, 0) };
    },
  };
}

/** The `+label` of a customer's simulator address in a world (docs/seed-spec.md §5). */
export function simulatorLabel(worldId: string, customerId: string): string {
  if (worldKindOf(worldId) === "QA" && customerId.startsWith("cus-qa-")) return customerId.slice("cus-".length);
  return worldId === "demo" ? customerId : `${worldId}-${customerId}`;
}

/** The simulator address behind a masked one (`s***@simulator.amazonses.com`), or `undefined`. */
export function simulatorAddressOf(worldId: string, customerId: string, emailMasked: string): string | undefined {
  const [local = "", domain = ""] = emailMasked.split("@");
  const mailbox = MAILBOX_BY_INITIAL[local.slice(0, 1)];
  if (domain !== SIMULATOR_DOMAIN || mailbox === undefined) return undefined;
  return `${mailbox}+${simulatorLabel(worldId, customerId)}@${SIMULATOR_DOMAIN}`;
}

export const simulatorEmailDirectory: EmailDirectory = {
  async addressOf(worldId, customer) {
    return simulatorAddressOf(worldId, customer.customerId, customer.emailMasked);
  },
};

/** `cus-0001` → `+5491100001001`: the synthetic number of a seed persona; nothing else, and never live. */
export function personaNumber(customerId: string): string | undefined {
  const match = PERSONA.exec(customerId);
  return match?.[1] === undefined ? undefined : `+5491100001${match[1].padStart(3, "0")}`;
}

export const personaRecipients: RecipientResolver = {
  async whatsAppNumber(_worldId: string, customerId: string, mode: ChannelMode) {
    return mode === "simulated" ? personaNumber(customerId) : undefined;
  },
};

export interface LiveRecipientDeps {
  readonly core: CoreClient;
  /** The world's simulated "now", sent to the core as `X-Sim-Now`. */
  readonly simNow: (worldId: string) => Promise<Date>;
  readonly stageModes: ChannelModes;
}

/**
 * The recipients of a deployed gate: the persona's synthetic number for the phone simulator, and in
 * `live` the core's `liveE164`, asked only for a world the stage lets run live. Nothing here decides
 * who may receive it: the gate's recipient fence and the live transport allow only the demo phones.
 */
export function coreRecipients(deps: LiveRecipientDeps): RecipientResolver {
  return {
    async whatsAppNumber(worldId, customerId, mode) {
      if (mode === "simulated") return personaNumber(customerId);
      if (!stageAllowsLiveWhatsApp(worldId, deps.stageModes)) return undefined;
      try {
        const simNow = (await deps.simNow(worldId)).toISOString();
        return (await deps.core.call("getLiveRecipient", { worldId, simNow, correlationId: `live-recipient.${customerId}` }, { params: { customerId } })).e164;
      } catch (error) {
        if (notFound(error)) return undefined;
        throw error;
      }
    },
  };
}
