// What the event workers (`EventWorker`, `SignupEventWorker`, `QaEventWorker`) run with in the stage,
// built once per container by handlers/event-worker.ts from what SST links into the function (lib/resource.ts
// and lib/secrets.ts, never `process.env`):
//
//   data         the DynamoDB connector                                  connector/dynamo
//   complaints   the register chain key, `AnchorWriter`, the milestones   RegisterChainKey, AnchorWriter, Scheduler
//   gate         `sendThroughGate`, the one exit; `reroute` over it       outbound/gate.ts
//   turn         the Harness, G1, Memory, the preloaded reads in process  Harness, GuardrailG1, SessionKey
//   handlers     the deterministic handlers of the other modules          worker/stage/handlers.ts
//   enqueuer     the worker's own queue (`inFlight` first)               Resource.<its queue>
//   queue        `ChangeMessageVisibility` of a poison delivery           its own queue
//
// Nothing is read at import time; every client is built on its first use.
import { stageAccountTarget } from "../agent-tools/account/handler";
import { productionOwnership } from "../agent-tools/account/ownership";
import { s3EmailObjectStore } from "../channels/email/store";
import type { DocumentStore } from "../agent-tools/complaints/ports";
import { productionToolDeps } from "../agent-tools/common/deps";
import { stageIdentityTarget } from "../agent-tools/identity/handler";
import { linkedHarnessClient } from "../agent/harness-client";
import { linkedMemoryRetriever } from "../agent/memory";
import { type ComplaintsDeps, stageComplaintsDeps } from "../complaints/deps";
import { dynamoConnector } from "../connector/dynamo/connector";
import { linkedCoreClient } from "../core/linked";
import { createLogger } from "../lib/log";
import { bucketName } from "../lib/resource";
import { keySecret } from "../lib/secrets";
import { linkedNetworkClient, linkedSettlementFileReader } from "../networks/linked";
import { rerouteThroughStageGate, sendThroughGate } from "../outbound/gate";
import { timerMilestoneScheduler } from "../timers/milestones";
import { stageTimerDeps } from "../timers/stage";
import type { TurnReads } from "../turns/preload";
import { linkedG1Prefilter } from "../turns/prefilter";
import { linkedEnqueuer } from "./enqueue";
import type { WorkerDeps } from "./ports";
import { stageEventHandlers } from "./stage/handlers";
import { sqsQueueVisibility } from "./stage/queue";

/** A value built on its first use and kept for the container. */
function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

/** `identify_customer`, `get_account` and `list_operations` in process, over the worker's own role. */
function stageTurnReads(): TurnReads {
  const deps = productionToolDeps(productionOwnership());
  return { identity: stageIdentityTarget(deps), account: stageAccountTarget(deps) };
}

export function productionWorkerDeps(): WorkerDeps {
  const now = (): Date => new Date();
  const data = dynamoConnector();
  const log = createLogger({ bindings: { service: "event-worker" } });
  const complaints = once((): ComplaintsDeps => ({ ...stageComplaintsDeps({ log, milestones: timerMilestoneScheduler(stageTimerDeps(log, { networks: true, scheduler: true })) }), connector: data }));
  const reads = once(stageTurnReads);
  const lazyReads: TurnReads = {
    identity: { invoke: (tool, input, caller) => reads().identity.invoke(tool, input, caller) },
    account: { invoke: (tool, input, caller) => reads().account.invoke(tool, input, caller) },
  };
  const documents = once((): DocumentStore => s3EmailObjectStore(bucketName("Documents")));
  return {
    data,
    complaints: complaints(),
    gate: sendThroughGate,
    reroute: rerouteThroughStageGate,
    turn: {
      harness: linkedHarnessClient(),
      prefilter: linkedG1Prefilter(),
      memory: linkedMemoryRetriever(),
      reads: lazyReads,
      sessionKey: () => keySecret("SessionKey"),
      agentMode: "REAL",
    },
    handlers: stageEventHandlers({ data, gate: sendThroughGate, complaints, core: linkedCoreClient, networks: linkedNetworkClient, settlementFiles: linkedSettlementFileReader, documents }),
    enqueuer: linkedEnqueuer(data, log),
    queue: sqsQueueVisibility(),
    now,
    loggerFor: (correlationId) => createLogger({ correlationId }),
  };
}
