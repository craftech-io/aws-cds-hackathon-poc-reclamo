// Where each scenario of scripts/scenarios runs on the local model. A scenario's model-dependent steps
// (the customer's conversation over the simulated WhatsApp) are agent tests in tests/agent; its
// deterministic steps (console, register, audit, metrics, clock, caps, guest worlds, sign-up, the live
// channel, the deployed stage itself) are already proven without a model by the local flows and unit
// tests (`npm test`) and stay with the stage's scenario runner. scenario-map.agent.test.ts keeps this map
// in step with scripts/scenarios, tests/agent and docs/flows-catalog.md.
//
//   SC     agent tests (tests/agent/…)                                   deterministic, covered by
//   SC-00  smoke (number on the spot)                                    deployed-stage checks only: FL-102, FL-094, FL-082, FL-090, FL-029, FL-100, FL-112
//   SC-01  smoke, scenarios/intake (challenge), scenarios/payments (main) FL-011, FL-075, FL-097
//   SC-02  scenarios/payments (C04 C11 C12 C13 C14 C15)                  FL-087 (execution by code)
//   SC-03  scenarios/receipts (C18 C16 C07 C19 C41)                      FL-021 (C17), FL-027 (fallback, disagree), FL-029 (C20, sizes, scans)
//   SC-04  scenarios/certificate (C05 C21)                               —
//   SC-05  scenarios/charges (C22 C02 C23 C24)                           FL-035 (rejection), FL-040 (monthly limit)
//   SC-06  scenarios/charges (C25 C03 C26)                               FL-037 (second complaint: CONFLICT)
//   SC-07  scenarios/transfers (C27 C28 C29 C30 C31)                     FL-042 (the network's transition by the clock)
//   SC-08  scenarios/transfers (C32 C33 C34)                             FL-047 (follow-up out of term)
//   SC-09  scenarios/account (C06 C35)                                   FL-050 (the core refuses a lift)
//   SC-10  scenarios/account (C36 quote and closure, C37 address, phone)  —
//   SC-11  smoke (hola), scenarios/intake                                FL-002 (unlinked number), FL-005 (two loans), FL-013 (repeated message)
//   SC-12  smoke (poem), scenarios/limits                                FL-062 (GROUNDING_FAIL probe), FL-060 (the button)
//   SC-13  scenarios/channel (C38 inside the window)                     FL-006 (opt-out, "baja"), FL-007 (operator by email), FL-074
//   SC-14  scenarios/channel (C09: the agent never collects)             FL-064 to FL-073, FL-075 (operator, reroutes, hours, caps, fence)
//   SC-15  scenarios/channel (deadline told from the tools)              FL-076 to FL-083 (milestones, escalation, overdue, Scheduler, closure)
//   SC-16  scenarios/limits (take, write, release), scenarios/payments (C13 approval)  FL-088 (self-approval), FL-087
//   SC-17  scenarios/certificate (C05 delivery, C39 bounce)              FL-092 (complaint), FL-093 (email viewer)
//   SC-18  —                                                             FL-014, FL-094 to FL-099 (console and register, no model)
//   SC-19  scenarios/limits (injection by text)                          FL-105 to FL-109 (caps, duplicates, failed turns, DLQ, kill switch)
//   SC-20  —                                                             FL-075, FL-098, FL-100, FL-101 (audit and metrics, no model)
//   SC-21  —                                                             FL-094, FL-098, FL-101 (guest tour, its turns are the flows above)
//   SC-22  —                                                             FL-099, FL-100, FL-104, FL-121 (guest worlds)
//   SC-23  —                                                             FL-103 (live WhatsApp: needs the product's own number, P-01)
//   SC-24  —                                                             FL-112 to FL-126 (guest sign-up)
//   EV-1   evals/grounding (the 40 questions)                            —
//   EV-2   —                                                             receipt reader, not the agent: its evaluation set feeds the flows' fake reader
//   EV-3   —                                                             input classifier, not the agent: its evaluation set feeds the flows' fake classifier

export interface ScenarioCoverage {
  /** Agent test files under tests/agent that play its model-dependent steps. */
  readonly agent: readonly string[];
  /** Flows of docs/flows-catalog.md that cover its deterministic steps without a model. */
  readonly flows: readonly string[];
}

export const SCENARIO_MAP: Readonly<Record<string, ScenarioCoverage>> = {
  "SC-00": { agent: ["smoke.agent.test.ts"], flows: ["FL-102", "FL-094", "FL-082", "FL-090", "FL-029", "FL-100", "FL-112"] },
  "SC-01": { agent: ["smoke.agent.test.ts", "scenarios/intake.agent.test.ts", "scenarios/payments.agent.test.ts"], flows: ["FL-011", "FL-075", "FL-097"] },
  "SC-02": { agent: ["scenarios/payments.agent.test.ts"], flows: ["FL-087"] },
  "SC-03": { agent: ["scenarios/receipts.agent.test.ts"], flows: ["FL-021", "FL-027", "FL-029"] },
  "SC-04": { agent: ["scenarios/certificate.agent.test.ts"], flows: [] },
  "SC-05": { agent: ["scenarios/charges.agent.test.ts"], flows: ["FL-035", "FL-040"] },
  "SC-06": { agent: ["scenarios/charges.agent.test.ts"], flows: ["FL-037"] },
  "SC-07": { agent: ["scenarios/transfers.agent.test.ts"], flows: ["FL-042"] },
  "SC-08": { agent: ["scenarios/transfers.agent.test.ts"], flows: ["FL-047"] },
  "SC-09": { agent: ["scenarios/account.agent.test.ts"], flows: ["FL-050"] },
  "SC-10": { agent: ["scenarios/account.agent.test.ts"], flows: [] },
  "SC-11": { agent: ["smoke.agent.test.ts", "scenarios/intake.agent.test.ts"], flows: ["FL-002", "FL-005", "FL-013"] },
  "SC-12": { agent: ["smoke.agent.test.ts", "scenarios/limits.agent.test.ts"], flows: ["FL-062", "FL-060"] },
  "SC-13": { agent: ["scenarios/channel.agent.test.ts"], flows: ["FL-006", "FL-007", "FL-074"] },
  "SC-14": { agent: ["scenarios/channel.agent.test.ts"], flows: ["FL-064", "FL-065", "FL-066", "FL-067", "FL-068", "FL-069", "FL-070", "FL-071", "FL-072", "FL-073", "FL-075"] },
  "SC-15": { agent: ["scenarios/channel.agent.test.ts"], flows: ["FL-076", "FL-077", "FL-078", "FL-079", "FL-080", "FL-081", "FL-082", "FL-083"] },
  "SC-16": { agent: ["scenarios/limits.agent.test.ts", "scenarios/payments.agent.test.ts"], flows: ["FL-088", "FL-087"] },
  "SC-17": { agent: ["scenarios/certificate.agent.test.ts"], flows: ["FL-092", "FL-093"] },
  "SC-18": { agent: [], flows: ["FL-014", "FL-094", "FL-095", "FL-096", "FL-097", "FL-098", "FL-099"] },
  "SC-19": { agent: ["scenarios/limits.agent.test.ts"], flows: ["FL-105", "FL-106", "FL-107", "FL-108", "FL-109"] },
  "SC-20": { agent: [], flows: ["FL-075", "FL-098", "FL-100", "FL-101"] },
  "SC-21": { agent: [], flows: ["FL-094", "FL-098", "FL-101"] },
  "SC-22": { agent: [], flows: ["FL-099", "FL-100", "FL-104", "FL-121"] },
  "SC-23": { agent: [], flows: ["FL-103"] },
  "SC-24": { agent: [], flows: ["FL-112", "FL-113", "FL-114", "FL-115", "FL-116", "FL-117", "FL-118", "FL-119", "FL-120", "FL-121", "FL-122", "FL-123", "FL-124", "FL-125", "FL-126"] },
};
