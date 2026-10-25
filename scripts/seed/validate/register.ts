// Invariants 12, 13 and 17 (docs/seed-spec.md §14): the register, refund register and tape chains of
// every template verify and their heads match `Runtime`; the complaint numbers are correlative
// (1..122 in demo/guest, 1..20 in qa-min) with the counter at the last one; every historical deadline
// is the one services/business-days.ts computes with the holiday table; the "seeded history" box of
// qa-min matches the manifest and no measured KPI of a template has N > 0.
import { deadline } from "@reclamo/bff/services/business-days";
import { complaintNumber } from "@reclamo/shared";
import { localOf } from "../generate/calendar";
import { verifyChain } from "../lib/chain";
import { EPOCH_PLACEHOLDER } from "../lib/constants";
import { seededHistoryBox } from "../lib/kpis";
import { canonicalJson } from "../lib/json";
import type { WorldTemplateFile } from "../lib/template";
import { type Json, type SeedOnDisk, entities } from "./read";

type Report = (invariant: number, message: string) => void;

const EXPECTED_COUNT: Readonly<Record<string, number>> = { demo: 122, guest: 122, "qa-min": 20 };

export function holidayDates(seed: SeedOnDisk): string[] {
  const holidays = (seed.reference.holidays as Json | undefined)?.entries as Json[] | undefined;
  return (holidays ?? []).map((holiday) => String(holiday.date));
}

function head(template: WorldTemplateFile, chain: string): Json | undefined {
  return template.items.find((item) => item.entity === "ChainHead" && item.pk.endsWith(`#COUNTER#${chain}#e${EPOCH_PLACEHOLDER}`))?.data as Json | undefined;
}

function checkChains(name: string, template: WorldTemplateFile, report: Report): void {
  const chains: Array<[string, string]> = [
    ["REGSEQ", "RegisterEntry"],
    ["RRISEQ", "RefundEntry"],
    ["TAPESEQ", "TapeEntry"],
  ];
  for (const [counter, entity] of chains) {
    const entries = entities(template, entity);
    const check = verifyChain(entries);
    if (!check.ok) report(12, `${name}: the ${entity} chain breaks at seq ${check.brokenAt ?? "?"}`);
    const stored = head(template, counter);
    if (!stored || stored.value !== check.head.value || stored.hash !== check.head.hash) report(12, `${name}: the ${counter} head does not match the chain`);
  }
  const filed = entities(template, "RegisterEntry").filter((entry) => entry.eventType === "FILED");
  const numbers = filed.map((entry) => String(entry.complaintNumber)).sort();
  const expected = Array.from({ length: EXPECTED_COUNT[name] ?? 0 }, (_, index) => complaintNumber(2026, index + 1));
  if (canonicalJson(numbers) !== canonicalJson(expected)) report(12, `${name}: complaint numbers are not 1..${expected.length} without gaps`);
  const counter = template.items.find((item) => item.entity === "Counter" && item.pk.includes("#COUNTER#CMP#"))?.data as Json | undefined;
  if (counter?.value !== expected.length) report(12, `${name}: the complaint counter is ${String(counter?.value)}, not ${expected.length}`);
  for (const complaint of entities(template, "Complaint")) {
    if (complaint.origin !== "SEED") report(17, `${name}: ${String(complaint.complaintId)} is not origin SEED`);
    if (!filed.some((entry) => entry.complaintId === complaint.complaintId && entry.complaintNumber === complaint.complaintNumber)) report(12, `${name}: ${String(complaint.complaintId)} has no FILED entry`);
  }
}

function checkDeadlines(name: string, template: WorldTemplateFile, holidays: readonly string[], report: Report): void {
  for (const complaint of entities(template, "Complaint")) {
    const expected = localOf(deadline(new Date(String(complaint.filedAtSim)), holidays));
    if (Date.parse(String(complaint.deadlineSim)) !== Date.parse(expected)) report(13, `${name}: ${String(complaint.complaintId)} deadline ${String(complaint.deadlineSim)} is not ${expected}`);
    const answer = complaint.answer as Json | undefined;
    if (answer?.sentAtSim && Date.parse(String(answer.sentAtSim)) > Date.parse(expected)) report(13, `${name}: ${String(complaint.complaintId)} was answered after its deadline`);
  }
}

export function checkRegister(seed: SeedOnDisk, report: Report): void {
  const holidays = holidayDates(seed);
  if (!holidays.includes("2026-11-09")) report(13, "the holiday table lacks Monday 09/11/2026");
  for (const name of ["demo", "guest", "qa-min"] as const) {
    checkChains(name, seed.templates[name], report);
    checkDeadlines(name, seed.templates[name], holidays, report);
    const box = seededHistoryBox(seed.templates[name]);
    if (box.measuredN !== 0) report(17, `${name}: a measured KPI has N = ${box.measuredN}`);
  }
  const recorded = (seed.manifest.facts as Json | undefined)?.qaMinSeededHistory;
  if (canonicalJson(recorded) !== canonicalJson(seededHistoryBox(seed.templates["qa-min"]))) report(17, "the qa-min seeded-history box differs from the manifest");
}
