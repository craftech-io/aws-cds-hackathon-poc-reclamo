// Invariants 15 and 18 to 22 (docs/seed-spec.md §14, docs/design-brief.md §15): the guided tour over
// the `guest` template. Until the local world of tests/flows/support/world.ts and the tour steps
// exist, they check the tour's contract on the template: a pristine world at Wed 07/10 10:10, the
// next number R-2026-000123, the first timer is the publication that reconciles C01 in one advance,
// no seeded complaint becomes overdue before the tour ends (Wed 21/10 10:00), the formal debt notice
// of step 2b is inside its hours, and C07's dates are the ones business-days.ts computes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { milestones } from "@reclamo/bff/services/business-days";
import { isBusinessDay, weekdayOf } from "@reclamo/shared";
import { addMinutes, localInstant, localOf } from "../generate/calendar";
import { REPO_ROOT, START_AT_SIM } from "../lib/constants";
import { type Json, type SeedOnDisk, debitsOf, entities, networkLines } from "./read";
import { holidayDates } from "./register";

type Report = (invariant: number, message: string) => void;

export const TOUR = {
  /** Step 2b: C09's collection attempt, a few minutes after the start. */
  collectionAttemptAt: addMinutes(START_AT_SIM, 5),
  /** End of the documented tour (deep tour, step 9 and the clock steps). */
  endsAt: localInstant("2026-10-21", "10:00"),
  /** Step 9 files C07's case after step 4 (Thu 08/10 08:30). */
  c07FiledAt: localInstant("2026-10-08", "08:35"),
  c07: { OPERATOR_REMINDER: "2026-10-16T10:00", SUPERVISOR_ESCALATION: "2026-10-21T10:00", DEADLINE: "2026-10-23T23:59" },
  firstNewNumber: "R-2026-000123",
} as const;

const LOCAL_WORLD = "tests/flows/support/world.ts";

function firstTimer(timers: readonly Json[]): Json | undefined {
  return timers
    .filter((timer) => timer.status === "SCHEDULED" && Date.parse(String(timer.dueAtSim)) > Date.parse(START_AT_SIM))
    .sort((a, b) => Date.parse(String(a.dueAtSim)) - Date.parse(String(b.dueAtSim)) || Number(a.seq) - Number(b.seq))[0];
}

function checkStart(seed: SeedOnDisk, report: Report): void {
  const guest = seed.templates.guest;
  const clock = entities(guest, "StoredClock")[0];
  if (clock?.mode !== "PAUSED" || clock.pausedSimNow !== START_AT_SIM) report(18, "the guest world must start paused at Wed 07/10 10:10");
  if (entities(guest, "Complaint").some((complaint) => complaint.customerId === "cus-0001")) report(18, "C01 must have no complaint at the start");
  const counter = guest.items.find((item) => item.entity === "Counter")?.data as Json | undefined;
  if (`R-2026-${String(Number(counter?.value ?? 0) + 1).padStart(6, "0")}` !== TOUR.firstNewNumber) report(18, `the first new complaint must be ${TOUR.firstNewNumber}`);
  if (!entities(guest, "Instalment").some((row) => row.loanId === "L-0009" && String(row.dueDate) < START_AT_SIM.slice(0, 10) && Number(row.paid) < Number(row.amount))) report(18, "C09 must have an overdue instalment (step 2b)");
  if (!entities(guest, "Charge").some((charge) => charge.customerId === "cus-0002" && charge.feeCode === "FEE-CARD-REPL")) report(18, "C02 must have the card replacement charge (step 6)");
  if (!debitsOf(guest).some((debit) => debit.customerId === "cus-0003" && debit.paymentId === undefined)) report(18, "C03 must have the duplicate debit (step 7)");
  if (!guest.receipts.some((receipt) => receipt.personaId === "C07" && receipt.variant === "fake-check")) report(18, "C07 must have the fake receipt (step 9)");
}

function checkTimers(seed: SeedOnDisk, report: Report): void {
  const guest = seed.templates.guest;
  const timers = entities(guest, "Timer");
  const first = firstTimer(timers);
  const publishKey = "NORTE-2026-10-07";
  if (first?.kind !== "SETTLEMENT_PUBLISH" || first.timerId !== publishKey) report(15, `the first timer after the start must be SETTLEMENT_PUBLISH ${publishKey}, it is ${String(first?.kind)} ${String(first?.timerId)}`);
  const publishAt = Date.parse(String(first?.dueAtSim ?? ""));
  const between = timers.filter((timer) => Date.parse(String(timer.dueAtSim)) > Date.parse(START_AT_SIM) && Date.parse(String(timer.dueAtSim)) < publishAt);
  if (between.length > 0) report(15, `${between.length} timer(s) fall between the start and the main story's publication`);
  if (first?.dueAtSim !== localInstant("2026-10-08", "08:30")) report(21, "the publication must be Thu 08/10 08:30");
  const line = networkLines(guest).find((candidate) => candidate.customerRef === "cus-0001" && candidate.status === "PENDING");
  const instalment = entities(guest, "Instalment").find((row) => row.loanId === "L-0001" && row.number === 4);
  if (!line || line.network !== "NORTE" || line.businessDate !== "2026-10-07" || line.loanRef !== "L-0001" || line.instalment !== 4) report(21, "C01's payment must be a pending line of NORTE 2026-10-07 on L-0001 instalment 4");
  else if (line.amount !== Number(instalment?.amount) - Number(instalment?.paid)) report(21, "C01's pending line must cover instalment 4 exactly (MATCHED in one advance)");
  for (const timer of timers.filter((candidate) => candidate.kind === "SLA" && (candidate.payload as Json).milestone === "DEADLINE")) {
    if (Date.parse(String(timer.dueAtSim)) <= Date.parse(TOUR.endsAt)) report(19, `${String(timer.timerId)} would make a seeded complaint overdue during the tour`);
  }
  for (const complaint of entities(guest, "Complaint").filter((candidate) => !["ANSWERED", "CLOSED"].includes(String(candidate.status)))) {
    if (Date.parse(String(complaint.deadlineSim)) <= Date.parse(TOUR.endsAt)) report(19, `${String(complaint.complaintId)} becomes overdue during the tour`);
  }
}

function checkFormalNotice(seed: SeedOnDisk, report: Report): void {
  const settings = seed.templates.guest.settings as Json;
  const hours = (settings.contactHours as Json | undefined)?.formalNotice as Json | undefined;
  const at = TOUR.collectionAttemptAt;
  const date = at.slice(0, 10);
  const time = at.slice(11, 16);
  const weekday = weekdayOf(date);
  const inside = weekday !== "SAT" && weekday !== "SUN" && isBusinessDay(date, holidayDates(seed)) && time >= String(hours?.from) && time < String(hours?.to);
  if (!inside) report(20, `step 2b at ${at} is outside the formal notice hours ${String(hours?.from)}-${String(hours?.to)}`);
}

function checkC07(seed: SeedOnDisk, report: Report): void {
  const dates = milestones(new Date(TOUR.c07FiledAt), holidayDates(seed));
  for (const [milestone, expected] of Object.entries(TOUR.c07)) {
    const actual = localOf(dates[milestone as keyof typeof dates]).slice(0, 16);
    if (actual !== expected) report(22, `C07's ${milestone} is ${actual}, the tour says ${expected}`);
  }
}

export function checkTour(seed: SeedOnDisk, report: Report, warn: (message: string) => void): void {
  checkStart(seed, report);
  checkTimers(seed, report);
  checkFormalNotice(seed, report);
  checkC07(seed, report);
  if (existsSync(join(REPO_ROOT, LOCAL_WORLD))) warn(`invariants 18-22: ${LOCAL_WORLD} exists; the LF replay of the tour runs in tour:check, these checks cover its contract`);
  else warn(`invariants 18-22: ${LOCAL_WORLD} does not exist yet; the tour's contract is checked on the template`);
}
