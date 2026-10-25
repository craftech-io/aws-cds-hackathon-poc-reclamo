// The seven Gateway targets of an in-process world, each built with its `create*Target` over the ports
// its Lambda gets in the stage (agent-tools/<target>/handler.ts), the link replaced by the local piece:
// the core with the target's own role (`ToolIdentity`, `ToolAccount`…; `ToolHandoff` only for its gate), the
// networks as `ToolInvestigation` / `ToolActions`, receipts/ over the scripted reader and the fake
// `Media`/`Seed`, reconcile/ over the network mock's published files, the real gate. The worker's
// preloaded reads use the `identity` and `account` targets again, with the worker's role
// (worker/production.ts `stageTurnReads`).
import type { CoreCaller } from "@reclamo/core-mock/http/caller";
import { connectorSimNow, coreOwnership } from "@reclamo/bff/agent-tools/account/ownership";
import { createAccountTarget } from "@reclamo/bff/agent-tools/account/target";
import { createActionsTarget } from "@reclamo/bff/agent-tools/actions/handler";
import { NO_CORE_OWNERSHIP } from "@reclamo/bff/agent-tools/actions/stage";
import type { CoreOwnership } from "@reclamo/bff/agent-tools/common/scope";
import type { GatewayTargetRuntime, ToolDeps } from "@reclamo/bff/agent-tools/common/handler";
import type { ToolTarget } from "@reclamo/bff/agent-tools/common/targets";
import { createComplaintsTarget } from "@reclamo/bff/agent-tools/complaints/handler";
import { createHandoffTarget } from "@reclamo/bff/agent-tools/handoff/handler";
import { createIdentityTarget } from "@reclamo/bff/agent-tools/identity/target";
import { signupImagePool } from "@reclamo/bff/agent-tools/investigation/ports";
import { type InvestigationPorts, createInvestigationTarget } from "@reclamo/bff/agent-tools/investigation/target";
import { createMessagingTarget } from "@reclamo/bff/agent-tools/messaging/handler";
import { coreLoanOwnership } from "@reclamo/bff/agent-tools/messaging/ownership";
import { createSettlementFileReader } from "@reclamo/bff/networks/settlement-files";
import { connectorReadBudget } from "@reclamo/bff/receipts/budget";
import { s3ImageStore } from "@reclamo/bff/receipts/linked";
import type { TurnReads } from "@reclamo/bff/turns/preload";
import { LOCAL_KEYS } from "../keys";
import { type StageContext, asS3Client, documentStore } from "./context";

export type LocalTargets = { readonly [T in ToolTarget]: GatewayTargetRuntime };

function toolDeps(stage: StageContext, ownership: CoreOwnership): ToolDeps {
  return { connector: stage.connector, sessionKey: () => LOCAL_KEYS.session, wallClock: stage.now, loggerFor: stage.loggerFor, ownership };
}

function ownershipOf(stage: StageContext, caller: CoreCaller): CoreOwnership {
  return coreOwnership(() => stage.mocks.core(caller), connectorSimNow(stage.connector, stage.now));
}

/** What `read_receipt` and `reconcile_payment` run with in `ToolInvestigation`. */
export function investigationPorts(stage: StageContext): InvestigationPorts {
  const s3 = asS3Client(stage.s3);
  const readFile = createSettlementFileReader({ s3: stage.s3, bucket: "Settlements" });
  return {
    core: () => stage.mocks.core("ToolInvestigation"),
    networks: () => stage.mocks.networks("ToolInvestigation"),
    complaints: () => stage.complaints(stage.loggerFor("local-investigation")),
    gate: stage.gate("ToolInvestigation"),
    receipts: (connector, log) => ({
      connector,
      bedrock: stage.reader,
      images: s3ImageStore({ Media: "Media", Seed: "Seed" }, s3),
      budget: connectorReadBudget({ connector, now: stage.now, signupImagePool: signupImagePool(connector), log }),
      now: stage.now,
      log,
    }),
    reconcile: (connector, log) => ({ connector, core: stage.mocks.core("ToolInvestigation"), network: stage.mocks.networks("ToolInvestigation"), readFile, now: stage.now, log }),
  };
}

/** The targets behind the Gateway, as the Harness reaches them. */
export function createLocalTargets(stage: StageContext): LocalTargets {
  const complaints = (log: Parameters<StageContext["complaints"]>[0]) => stage.complaints(log);
  return {
    identity: createIdentityTarget(toolDeps(stage, ownershipOf(stage, "ToolIdentity")), {
      core: () => stage.mocks.core("ToolIdentity"),
      complaints: () => stage.complaints(stage.loggerFor("local-identity")),
      gate: stage.gate("ToolIdentity"),
    }),
    account: createAccountTarget(toolDeps(stage, ownershipOf(stage, "ToolAccount")), { core: () => stage.mocks.core("ToolAccount") }),
    investigation: createInvestigationTarget(toolDeps(stage, ownershipOf(stage, "ToolInvestigation")), investigationPorts(stage)),
    actions: createActionsTarget(toolDeps(stage, NO_CORE_OWNERSHIP), { core: () => stage.mocks.core("ToolActions"), networks: () => stage.mocks.networks("ToolActions"), complaints }),
    complaints: createComplaintsTarget(toolDeps(stage, NO_CORE_OWNERSHIP), { core: () => stage.mocks.core("ToolComplaints"), gate: stage.gate("ToolComplaints"), complaints, documents: documentStore(stage.s3) }),
    messaging: createMessagingTarget(toolDeps(stage, coreLoanOwnership(stage.connector, () => stage.mocks.core("ToolMessaging"), undefined, stage.now)), { gate: stage.gate("ToolMessaging") }),
    handoff: createHandoffTarget(toolDeps(stage, NO_CORE_OWNERSHIP), { gate: stage.gate("ToolHandoff"), complaints }),
  };
}

/** `identify_customer`, `get_account` and `list_operations` in process with the worker's own role. */
export function workerReads(stage: StageContext, worker: CoreCaller): TurnReads {
  const core = () => stage.mocks.core(worker);
  const deps = toolDeps(stage, ownershipOf(stage, worker));
  return {
    identity: createIdentityTarget(deps, { core, complaints: () => stage.complaints(stage.loggerFor("local-worker-reads")), gate: stage.gate(worker) }),
    account: createAccountTarget(deps, { core }),
  };
}
