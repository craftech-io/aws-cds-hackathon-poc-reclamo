// The outside world of the `investigation` target: the core and network clients, the receipt reader
// and the reconciliation of receipts/ and reconcile/, and what a hand-over by code needs (complaints/
// and the outbound gate). The deployed entry builds them from what SST links into `ToolInvestigation`,
// once per container and on first use; the tests and the local flows pass the in-process mocks.
import { isConflict } from "../../connector/errors";
import { keys } from "../../connector/keys";
import { realDayStamp } from "../../connector/repos/caps";
import { cond } from "../../connector/store";
import { expiry } from "../../connector/ttl";
import type { Connector } from "../../connector/port";
import { type ComplaintsDeps, stageComplaintsDeps } from "../../complaints/deps";
import { linkedCoreClient } from "../../core/linked";
import type { Logger } from "../../lib/log";
import { linkedNetworkClient, linkedSettlementFileReader } from "../../networks/linked";
import { sendThroughGate } from "../../outbound/gate";
import { connectorReadBudget } from "../../receipts/budget";
import { linkedBedrockReceiptReader, linkedImageStore } from "../../receipts/linked";
import type { ReceiptServiceDeps } from "../../receipts/service";
import type { ReconcileDeps } from "../../reconcile/service";
import { productionCore } from "../account/core";
import type { InvestigationPorts } from "./target";

/** Image reads of every self-signup world together per real day (docs/architecture-guests.md §11). */
export const SIGNUP_IMAGE_READS_PER_DAY = 200;

/** `GLOBALCAP#SIGNUPIMG#<realDay>`: one more image read of the self-signup pool, unless it is full. */
export function signupImagePool(connector: Pick<Connector, "write">): (at: Date) => Promise<boolean> {
  return async (at) => {
    try {
      await connector.write({
        kind: "update",
        table: "Runtime",
        key: keys.global("GLOBALCAP", "SIGNUPIMG", realDayStamp(at)),
        condition: cond.or(cond.notExists("count"), cond.lt("count", SIGNUP_IMAGE_READS_PER_DAY)),
        update: { add: { count: 1 }, set: { entity: "CapCounter", updatedAt: at.toISOString(), ...expiry("cap", undefined, at) } },
      });
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  };
}

let complaintsDeps: ComplaintsDeps | undefined;

export function productionInvestigationPorts(): InvestigationPorts {
  return {
    core: productionCore,
    networks: linkedNetworkClient,
    complaints: () => (complaintsDeps ??= stageComplaintsDeps()),
    gate: sendThroughGate,
    receipts: (connector, log: Logger): ReceiptServiceDeps => ({
      connector,
      bedrock: linkedBedrockReceiptReader(log),
      images: linkedImageStore(),
      budget: connectorReadBudget({ connector, now: () => new Date(), signupImagePool: signupImagePool(connector), log }),
      now: () => new Date(),
      log,
    }),
    reconcile: (connector, log): ReconcileDeps => ({ connector, core: linkedCoreClient(), network: linkedNetworkClient(), readFile: linkedSettlementFileReader(), now: () => new Date(), log }),
  };
}
