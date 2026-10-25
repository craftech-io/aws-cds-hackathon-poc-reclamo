// Lambda entry of `ToolComplaints` (docs/architecture.md §9.2): the infra points the Function at
// `packages/bff/src/agent-tools/complaints/handler.handler`. The deployed entry accepts only a Gateway
// call with the turn's token (`LAM-CALLER`). Every message goes through the imported `sendThroughGate`;
// the role holds TIMERS, so the milestones a registration, an answer or a withdrawal creates or cancels
// get their schedules from here when the world runs (timers/milestones.ts). `createComplaintsTarget`
// takes other ports in the local flows and the tests.
import { s3EmailObjectStore } from "../../channels/email/store";
import type { MilestoneScheduler } from "../../complaints/deps";
import { linkedCoreClient } from "../../core/linked";
import { createLogger } from "../../lib/log";
import { bucketName } from "../../lib/resource";
import { sendThroughGate } from "../../outbound/gate";
import { timerMilestoneScheduler } from "../../timers/milestones";
import { stageTimerDeps } from "../../timers/stage";
import type { Implementations } from "../common/context";
import { lambdaEntry } from "../common/deps";
import { type GatewayTargetRuntime, type ToolDeps, createToolHandler } from "../common/handler";
import { NO_CORE_OWNERSHIP, stageComplaintsDeps } from "../actions/stage";
import type { ComplaintPorts, DocumentStore } from "./ports";
import { registerComplaintTool } from "./register-tool";
import { COMPLAINTS_TOOLS } from "./schema";
import { updateComplaintTool } from "./update-tool";
import { answerInWritingTool } from "./written-answer";

export function complaintsImplementations(ports: ComplaintPorts): Implementations<typeof COMPLAINTS_TOOLS> {
  return {
    register_complaint: registerComplaintTool(ports),
    update_complaint: updateComplaintTool(ports),
    answer_complaint_in_writing: answerInWritingTool(ports),
  };
}

/** The ports of the stage: the linked core and `Documents`, the gate, complaints/ over the tool's connector. */
export function stageComplaintPorts(deps: Pick<ToolDeps, "connector">, milestones?: MilestoneScheduler): ComplaintPorts {
  let documents: DocumentStore | undefined;
  return {
    core: linkedCoreClient,
    gate: sendThroughGate,
    complaints: stageComplaintsDeps(deps.connector, milestones),
    documents: () => (documents ??= s3EmailObjectStore(bucketName("Documents"))),
  };
}

export function createComplaintsTarget(deps: ToolDeps, ports: ComplaintPorts = stageComplaintPorts(deps)): GatewayTargetRuntime {
  return createToolHandler({ target: "complaints", tools: COMPLAINTS_TOOLS, implementations: complaintsImplementations(ports) }, deps);
}

/** The Scheduler of the stage for the complaint's timers (no network calls from this role). */
function stageMilestones(): MilestoneScheduler {
  return timerMilestoneScheduler(stageTimerDeps(createLogger({ bindings: { service: "agent-tools", target: "complaints" } }), { networks: false, scheduler: true }));
}

export const handler = lambdaEntry((deps) => createComplaintsTarget(deps, stageComplaintPorts(deps, stageMilestones())), () => NO_CORE_OWNERSHIP);
