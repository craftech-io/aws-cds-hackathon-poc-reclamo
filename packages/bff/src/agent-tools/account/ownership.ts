// `LAM-SCOPE` against the core (agent-tools/common/scope.ts): whether a loan, charge, transfer or wallet
// movement the model named is the session customer's. The core is the only source: a loan is the
// customer's when the core lists it in the customer's account; a charge, a transfer or a movement when
// it appears among the customer's operations of the last 90 days of the world's clock (the widest
// window the core answers, docs/tool-catalog.md `list_operations`). Anything the core does not show
// for this customer, or an id the contract would refuse, is not theirs; a core that does not answer
// fails the call (`UNAVAILABLE`), never opens it.
import { CoreError } from "../../core/errors";
import { LoanId } from "@reclamo/core-contract";
import { dynamoConnector } from "../../connector/dynamo/connector";
import type { Connector } from "../../connector/port";
import { ClockState, simulatedNow } from "../../lib/clock";
import { isoAr } from "../../complaints/sla";
import type { CoreOwnership } from "../common/scope";
import { type CorePort, productionCore } from "./core";
import { localDate, shiftDate } from "./format";

/** The widest window of the core's operations route. */
export const OWNERSHIP_WINDOW_DAYS = 90;

/** The world's simulated "now", read from its stored clock (the session is not part of the ownership call). */
export type SimNowReader = (worldId: string) => Promise<string>;

export function connectorSimNow(connector: Connector, realNow: () => Date): SimNowReader {
  return async (worldId) => {
    const stored = await connector.runtime.getClock(worldId);
    if (stored === undefined) throw new CoreError("UNAVAILABLE", "the world has no clock", { attempts: 0 });
    return isoAr(simulatedNow(ClockState.parse(stored), realNow()));
  };
}

export function coreOwnership(core: CorePort, simNow: SimNowReader): CoreOwnership {
  return {
    async owns(kind, ref) {
      const now = await simNow(ref.worldId);
      const ctx = { worldId: ref.worldId, simNow: now };
      if (kind === "LOAN") {
        if (!LoanId.safeParse(ref.id).success) return false;
        const customer = await core().call("getCustomer", ctx, { params: { customerId: ref.customerId } });
        return customer.loans.some((loan) => loan.loanId === ref.id);
      }
      const to = localDate(now);
      const list = await core().call("listOperations", ctx, {
        params: { customerId: ref.customerId },
        query: { from: shiftDate(to, -OWNERSHIP_WINDOW_DAYS), to, kind: kind === "CHARGE" ? "CHARGE" : "ALL" },
      });
      return list.operations.some((operation) => {
        if (kind === "MOVEMENT") return operation.operationId === ref.id;
        if (kind === "CHARGE") return operation.ref.chargeId === ref.id || operation.operationId === ref.id;
        return operation.ref.transferId === ref.id;
      });
    },
  };
}

/** The ownership a deployed target checks with: the linked core and the world's stored clock. */
export function productionOwnership(): CoreOwnership {
  return coreOwnership(productionCore, connectorSimNow(dynamoConnector(), () => new Date()));
}
