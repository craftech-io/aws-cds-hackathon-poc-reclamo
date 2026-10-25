// `LAM-SCOPE` of `send_whatsapp`'s button refs (`BUTTON_REF`: a complaint of the session or a loan of the
// customer). A loan is the customer's only if the core says so: `getLoan` at the world's simulated
// instant (read from the world's clock, never the machine's), and a loan of another customer, an unknown
// one or a core that does not answer is not the customer's (fail closed). The target names no charge,
// transfer or movement id, so those are never the customer's here.
import type { CoreClient } from "../../core/client";
import type { Connector } from "../../connector/port";
import { worldClock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import type { CoreOwnership } from "../common/scope";

export function coreLoanOwnership(connector: Pick<Connector, "runtime">, core: () => CoreClient, log?: Logger, realNow?: () => Date): CoreOwnership {
  return {
    async owns(kind, ref) {
      if (kind !== "LOAN") return false;
      try {
        const simNow = await worldClock(ref.worldId, connector.runtime.clockState, realNow === undefined ? undefined : { now: async () => realNow() }).now();
        const loan = await core().call("getLoan", { worldId: ref.worldId, simNow: simNow.toISOString() }, { params: { loanId: ref.id } });
        return loan.customerId === ref.customerId;
      } catch (error) {
        log?.warn("tool.loan_ownership_unknown", { error });
        return false;
      }
    },
  };
}
