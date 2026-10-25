// Builds the `Connector` over a storage engine: the same repositories, conditions and keys run on
// DynamoDB and in memory.
import type { RepoContext } from "./codec";
import type { Connector, ConnectorOptions } from "./port";
import { auditRepo } from "./repos/audit";
import { capsRepo } from "./repos/caps";
import { caseItemsRepo } from "./repos/case-items";
import { chainsRepo } from "./repos/chains";
import { claimsRepo } from "./repos/claims";
import { complaintsRepo } from "./repos/complaints";
import { conversationsRepo } from "./repos/conversations";
import { countersRepo } from "./repos/counters";
import { emailsRepo } from "./repos/emails";
import { metricsRepo, referenceRepo } from "./repos/metrics";
import { runtimeRepo } from "./repos/runtime";
import { scansRepo } from "./repos/scans";
import { sessionsRepo } from "./repos/sessions";
import { timersRepo } from "./repos/timers";
import { worldItemsRepo } from "./repos/world-items";
import { worldsRepo } from "./repos/worlds";
import type { TableStore } from "./store";

export function createConnector(store: TableStore, options: ConnectorOptions = {}): Connector {
  const ctx: RepoContext = { store, now: options.now ?? (() => new Date()) };
  return {
    worlds: worldsRepo(ctx),
    complaints: complaintsRepo(ctx),
    caseItems: caseItemsRepo(ctx),
    chains: chainsRepo(ctx),
    audit: auditRepo(ctx),
    timers: timersRepo(ctx),
    conversations: conversationsRepo(ctx),
    emails: emailsRepo(ctx),
    runtime: runtimeRepo(ctx),
    counters: countersRepo(ctx),
    claims: claimsRepo(ctx),
    scans: scansRepo(ctx),
    sessions: sessionsRepo(ctx),
    caps: capsRepo(ctx),
    metrics: metricsRepo(ctx),
    reference: referenceRepo(ctx),
    worldItems: worldItemsRepo(ctx),
    transact: (ops) => store.transact(ops),
    write: async (op) => {
      await store.write(op);
    },
  };
}
