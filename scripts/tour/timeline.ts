// The replay of the guest's guided tour (docs/seed-spec.md §14, invariants 18 to 22; docs/test-plan.md §3):
// walks packages/web/src/views/tour/steps.ts over a world loaded with the `guest` template and checks,
// after every step, the state its "Qué mirar" promises:
//
//   18  every step reaches its expected state (number and deadline, the blocked collection attempt and
//       its formal email, the reading and the pending batch, the settlement and the written answer, the
//       reversal, the approval executed once, the operator's blocked text, the human case and its
//       milestones, the verified register)
//   19  no seeded complaint turns OVERDUE along the way (the tour ends on Wed 21/10 10:00)
//   20  the collection attempt of 2b happens inside the formal notice's hours and its reroute is ALLOWED
//   21  ONE "Avanzar al próximo evento" from step 3 takes the main story from PENDING_BATCH to MATCHED
//   22  the dates of step 9 (filed 08/10, reminder 16/10, escalation 21/10, due 23/10) are the world's
//
// The world is a port: scripts/tour/lf-world.ts binds it to the in-process world of the local flows
// with the scripted Harness (scripts/tour/autopilot.ts). `open` moves take the guest to a view; what the
// guest does there (compose, approve, take over and write, answer in writing) is a `GuestTask` of the
// step. The optional live clock (step 11) needs real schedules and is left to SC-21 in the stage.
import { type TourAction, type TourPersona, type TourStep, type TourStepId, HUMAN_CASE, MAIN_STORY, NORTE_PUBLISH, TOUR_START_SIM, TOUR_STEPS } from "../../packages/web/src/views/tour/steps";

export interface FiredTimer {
  readonly kind: string;
  readonly timerId: string;
  readonly dueAtSim: string;
}

export interface TourLanding {
  readonly simNow: string;
  readonly fired: readonly FiredTimer[];
}

export interface ComplaintView {
  readonly number: string;
  readonly status: string;
  readonly slaState: string;
  readonly filedAtSim: string;
  readonly deadlineSim: string;
}

export interface TapeView {
  readonly tapeId: string;
  readonly kind: string;
  readonly channel: string;
  readonly decision: string;
  readonly ruleIds: readonly string[];
  readonly rerouteOf?: string;
}

/** What the replay reads of the world, by persona (`Cnn` is customer `cus-00nn`). */
export interface TourProbe {
  clock(): Promise<{ readonly simNow: string; readonly mode: string }>;
  pristine(): Promise<boolean>;
  complaint(persona: TourPersona): Promise<ComplaintView | undefined>;
  milestones(persona: TourPersona): Promise<readonly { readonly milestone: string; readonly status: string; readonly dueAtSim: string }[]>;
  outbound(persona: TourPersona): Promise<readonly { readonly kind: string; readonly disclosure: boolean; readonly buttons: readonly string[] }[]>;
  emails(persona: TourPersona): Promise<readonly { readonly kind: string; readonly deliveryProof?: string }[]>;
  /** `source` of a receipt reading: `BEDROCK`, `FALLBACK`, `BOTH_AGREE` or `DISAGREE`. */
  evidence(persona: TourPersona): Promise<readonly { readonly kind: string; readonly result?: string; readonly source?: string }[]>;
  actions(persona: TourPersona): Promise<readonly { readonly kind: string; readonly status: string }[]>;
  approvals(persona: TourPersona): Promise<readonly { readonly decision: string; readonly executed: boolean }[]>;
  /** Tape entries written since the replay started. */
  newTape(): Promise<readonly TapeView[]>;
  seededComplaints(): Promise<readonly { readonly number: string; readonly slaState: string }[]>;
  /** N of the complaints "Este mundo" measures; undefined when the metrics did not answer. */
  measured(): Promise<number | undefined>;
  /** Result of the last register export (`ok` / `partial` / `broken`). */
  lastExport(): string | undefined;
  /** Events the world's queues gave up on (type and reason), never expected along the tour. */
  deadLetters(): readonly string[];
}

/** What the guest does in a view a step opened. */
export type GuestTask = "COLLECTION_ATTEMPT_C09" | "APPROVE_C03" | "TAKE_OVER_AND_WRITE_C09" | "ANSWER_C07";

export interface TourWorld extends TourProbe {
  /** A `run` move as `tour.run` does it; returns once the world is quiet (with the landing of a clock move). */
  run(action: TourAction): Promise<TourLanding | undefined>;
  task(task: GuestTask): Promise<void>;
}

/** The guest's work behind each `open` move, by step and view. */
export const GUEST_TASKS: Readonly<Partial<Record<`${TourStepId}:${string}`, readonly GuestTask[]>>> = {
  "2b:customer": ["COLLECTION_ATTEMPT_C09"],
  "7:approvals": ["APPROVE_C03"],
  "8:customer": ["TAKE_OVER_AND_WRITE_C09"],
  "9:complaint": ["ANSWER_C07"],
};

/** The steps the replay walks: the optional live clock needs the Scheduler. */
export const REPLAYED_STEPS: readonly TourStep[] = TOUR_STEPS.filter((step) => step.optional !== true);

export interface StepReport {
  readonly id: TourStepId;
  readonly simNow: string;
  readonly landings: readonly TourLanding[];
  readonly problems: readonly string[];
}

export interface TimelineReport {
  readonly steps: readonly StepReport[];
  readonly problems: readonly string[];
  /** What went wrong in the world without breaking a promise of the tour (dead-lettered events). */
  readonly warnings: readonly string[];
}

const same = (a: string | undefined, b: string) => a !== undefined && Date.parse(a) === Date.parse(b);
const AR_OFFSET_MS = -3 * 60 * 60_000;

/** Monday to Friday, 09:00 to 18:00 in Argentina: the formal debt notice's hours (template `guest`). */
export function inFormalNoticeHours(instant: string): boolean {
  const local = new Date(Date.parse(instant) + AR_OFFSET_MS);
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes <= 18 * 60;
}

type Check = (world: TourProbe, context: { readonly landings: readonly TourLanding[]; readonly tape: readonly TapeView[] }) => Promise<string[]>;

const has = (condition: boolean, problem: string): string[] => (condition ? [] : [problem]);

async function answered(world: TourProbe, persona: TourPersona, step: string): Promise<string[]> {
  const [complaint, emails] = await Promise.all([world.complaint(persona), world.emails(persona)]);
  return [
    ...has(complaint?.status === "ANSWERED", `${step}: ${persona}'s complaint is ${complaint?.status ?? "missing"}, not ANSWERED`),
    ...has(emails.some((email) => email.kind === "FORMAL_ANSWER" && email.deliveryProof === "DELIVERED"), `${step}: ${persona}'s written answer has no DELIVERED proof`),
  ];
}

/** The state each step promises once its moves are done. */
export const STEP_CHECKS: Readonly<Partial<Record<TourStepId, Check>>> = {
  "1": async (world) => {
    const clock = await world.clock();
    return [
      ...has(same(clock.simNow, TOUR_START_SIM) && clock.mode === "PAUSED", `1: the world starts at ${clock.simNow} (${clock.mode}), the tour at ${TOUR_START_SIM} paused`),
      ...has(await world.pristine(), "1: the world is not pristine at the start"),
    ];
  },
  "2": async (world) => {
    const [complaint, outbound] = await Promise.all([world.complaint("C01"), world.outbound("C01")]);
    const ack = outbound.find((message) => message.kind === "COMPLAINT_ACK");
    return [
      ...has(complaint?.number === MAIN_STORY.number, `2: the main story's number is ${complaint?.number ?? "missing"}, not ${MAIN_STORY.number}`),
      ...has(same(complaint?.deadlineSim, MAIN_STORY.deadlineSim), `2: the main story is due ${complaint?.deadlineSim ?? "never"}, not ${MAIN_STORY.deadlineSim}`),
      ...has(ack?.disclosure === true, "2: the acknowledgement does not open with the automated-assistant line"),
      ...has(["ACCEPT_EMAIL", "TALK_TO_HUMAN"].every((action) => ack?.buttons.includes(action) === true), "2: the acknowledgement does not offer “Sí, a ese email” and “Hablar con alguien”"),
    ];
  },
  "2b": async (world, { tape }) => {
    const blocked = tape.find((entry) => entry.decision === "BLOCKED" && entry.kind === "COLLECTION_REMINDER" && entry.channel === "WHATSAPP" && entry.ruleIds.includes("CH-WA-NO-COLLECTION"));
    const notice = blocked === undefined ? undefined : tape.find((entry) => entry.rerouteOf === blocked.tapeId && entry.kind === "COLLECTION_NOTICE_EMAIL");
    const clock = await world.clock();
    return [
      ...has(blocked !== undefined, "2b: no BLOCKED collection reminder by WhatsApp with CH-WA-NO-COLLECTION on the tape"),
      ...has(notice?.decision === "ALLOWED" && notice.channel === "EMAIL", `2b: the formal email of the blocked reminder is ${notice?.decision ?? "missing"}, not ALLOWED`),
      ...has(inFormalNoticeHours(clock.simNow), `2b: the clock (${clock.simNow}) is outside the formal notice's hours`),
    ];
  },
  "3": async (world) => {
    const [complaint, evidence, mine, theirs] = await Promise.all([world.complaint("C01"), world.evidence("C01"), world.emails("C01"), world.emails("C09")]);
    return [
      ...has(complaint?.status === "AWAITING_SETTLEMENT", `3: the main story is ${complaint?.status ?? "missing"}, not AWAITING_SETTLEMENT`),
      ...has(evidence.some((item) => item.kind === "RECEIPT_READING" && item.result === "READ"), "3: the receipt was not read"),
      // The landing says the receipt is read by the model and checked by the fallback: the step shows it so.
      ...has(
        evidence.some((item) => item.kind === "RECEIPT_READING" && item.source === "BOTH_AGREE"),
        `3: the receipt reading is ${evidence.find((item) => item.kind === "RECEIPT_READING")?.source ?? "missing"}, not the model's reading confirmed by the fallback (BOTH_AGREE)`,
      ),
      ...has(evidence.some((item) => item.kind === "SETTLEMENT_MATCH" && item.result === "PENDING_BATCH"), "3: the reconciliation is not PENDING_BATCH"),
      ...has(mine.some((email) => email.kind === "ACK_EMAIL" && email.deliveryProof === "DELIVERED"), "3: the acknowledgement email has no DELIVERED proof"),
      ...has(theirs.some((email) => email.kind === "COLLECTION_NOTICE_EMAIL" && email.deliveryProof === "DELIVERED"), "3: the formal notice of 2b has no DELIVERED proof"),
    ];
  },
  "4": async (world, { landings }) => {
    const [landing] = landings;
    const [evidence, actions] = await Promise.all([world.evidence("C01"), world.actions("C01")]);
    return [
      ...has(landings.length === 1 && same(landing?.simNow, NORTE_PUBLISH.dueAtSim), `4: one advance lands at ${landing?.simNow ?? "nothing"}, not ${NORTE_PUBLISH.dueAtSim}`),
      ...has(landing?.fired.some((timer) => timer.kind === "SETTLEMENT_PUBLISH" && same(timer.dueAtSim, NORTE_PUBLISH.dueAtSim)) === true, "4: the advance did not publish the settlement"),
      ...has(evidence.some((item) => item.kind === "SETTLEMENT_MATCH" && item.result === "MATCHED"), "4: the main story did not reach MATCHED in the same advance"),
      ...has(actions.filter((action) => action.kind === "APPLY_PAYMENT" && action.status === "EXECUTED").length === 1, "4: the payment was not applied exactly once"),
      ...(await answered(world, "C01", "4")),
    ];
  },
  "5": async (world) => has(((await world.measured()) ?? 0) >= 1, "5: “Este mundo” does not measure the guest's complaints"),
  "6": async (world) => [
    ...has((await world.actions("C02")).some((action) => action.kind === "REVERSE_CHARGE" && action.status === "EXECUTED"), "6: the charge was not reversed"),
    ...(await answered(world, "C02", "6")),
  ],
  "7": async (world) => {
    const [approvals, actions] = await Promise.all([world.approvals("C03"), world.actions("C03")]);
    return [
      ...has(approvals.length === 1 && approvals[0]?.decision === "APPROVED" && approvals[0].executed, "7: the agent's approval request was not approved and executed"),
      ...has(actions.filter((action) => action.kind === "REFUND_DUPLICATE" && action.status === "EXECUTED").length === 1, "7: the refund was not executed exactly once"),
    ];
  },
  "8": async (_world, { tape }) =>
    has(
      tape.some((entry) => entry.decision === "BLOCKED" && entry.kind === "OPERATOR_MESSAGE" && entry.channel === "WHATSAPP" && entry.ruleIds.includes("CH-WA-NO-COLLECTION")),
      "8: the operator's collection text was not BLOCKED by CH-WA-NO-COLLECTION",
    ),
  "9": async (world, { landings }) => {
    const [complaint, milestones] = await Promise.all([world.complaint("C07"), world.milestones("C07")]);
    const fired = (landing: TourLanding | undefined, milestone: string) => landing?.fired.some((timer) => timer.kind === "SLA" && timer.timerId.endsWith(milestone)) === true;
    return [
      ...has(same(complaint?.filedAtSim, HUMAN_CASE.filedSim), `9: the human case was filed ${complaint?.filedAtSim ?? "never"}, not ${HUMAN_CASE.filedSim}`),
      ...has(same(complaint?.deadlineSim, HUMAN_CASE.deadlineSim), `9: the human case is due ${complaint?.deadlineSim ?? "never"}, not ${HUMAN_CASE.deadlineSim}`),
      ...has(same(landings[0]?.simNow, HUMAN_CASE.reminderSim) && fired(landings[0], "OPERATOR_REMINDER"), `9: the first milestone advance lands at ${landings[0]?.simNow ?? "nothing"}, not the reminder of ${HUMAN_CASE.reminderSim}`),
      ...has(same(landings[1]?.simNow, HUMAN_CASE.escalationSim) && fired(landings[1], "SUPERVISOR_ESCALATION"), `9: the second milestone advance lands at ${landings[1]?.simNow ?? "nothing"}, not the escalation of ${HUMAN_CASE.escalationSim}`),
      ...has(complaint?.slaState === "AT_RISK", `9: the human case is ${complaint?.slaState ?? "missing"}, not AT_RISK`),
      ...has(complaint?.status === "ANSWERED", `9: the operator's written answer left the case ${complaint?.status ?? "missing"}, not ANSWERED`),
      ...has(milestones.some((timer) => timer.milestone === "DEADLINE" && timer.status === "CANCELLED"), "9: the remaining milestone was not CANCELLED by the written answer"),
    ];
  },
  "10": async (world) => has(world.lastExport() === "ok", `10: the register export says ${world.lastExport() ?? "nothing"}, not ok`),
  "12": async (world) => has(((await world.measured()) ?? 0) >= 1, "12: the metrics do not measure the guest's complaints"),
};

async function walkStep(world: TourWorld, step: TourStep): Promise<{ landings: TourLanding[]; failures: string[] }> {
  const landings: TourLanding[] = [];
  const failures: string[] = [];
  for (const move of step.moves) {
    try {
      if (move.kind === "run") {
        const landing = await world.run(move.action);
        if (landing !== undefined) landings.push(landing);
        continue;
      }
      for (const task of GUEST_TASKS[`${step.id}:${move.target.view}`] ?? []) await world.task(task);
    } catch (error) {
      failures.push(`${step.id}: “${move.label.en}” failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { landings, failures };
}

/** Walks the replayed steps over `world` and reports every promise of the tour the world did not keep. */
export async function walkTour(world: TourWorld, steps: readonly TourStep[] = REPLAYED_STEPS): Promise<TimelineReport> {
  const reports: StepReport[] = [];
  for (const step of steps) {
    const { landings, failures } = await walkStep(world, step);
    const check = STEP_CHECKS[step.id];
    const problems = [...failures, ...(check === undefined ? [] : await check(world, { landings, tape: await world.newTape() }))];
    reports.push({ id: step.id, simNow: (await world.clock()).simNow, landings, problems });
  }
  const overdue = (await world.seededComplaints()).filter((complaint) => complaint.slaState === "OVERDUE").map((complaint) => complaint.number);
  const end = (await world.clock()).simNow;
  const problems = [
    ...reports.flatMap((report) => report.problems),
    ...has(overdue.length === 0, `seeded complaints turned OVERDUE during the tour: ${overdue.join(", ")}`),
    ...has(same(end, HUMAN_CASE.escalationSim), `the tour ends at ${end}, not at ${HUMAN_CASE.escalationSim}`),
  ];
  const dead = world.deadLetters();
  return { steps: reports, problems, warnings: dead.length === 0 ? [] : [`${dead.length} event(s) dead-lettered during the replay: ${[...new Set(dead)].join(", ")}`] };
}
