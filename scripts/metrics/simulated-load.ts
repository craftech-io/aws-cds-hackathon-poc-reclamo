// The simulated load (docs/seed-spec.md §13, docs/design-brief.md §11): the 300 presentations of
// `simulated-complaints.jsonl` through the local pipeline (scripts/metrics/pipeline.ts: rules
// classifier, scripted agent, real policy, gate, register, clock and milestones in process), then
// PolicyAudit over the world. It produces the `Metrics` rows (`source SIMULATED_LOAD`, `agentMode
// SCRIPTED`) and the run's mechanics (numbering without gaps, milestones scheduled and cancelled, the
// gate's decisions by rule, violations), which the "Carga simulada" tab shows and nothing else.
//
//   npx tsx scripts/metrics/simulated-load.ts [--inputs <jsonl>] [--limit <n>] [--out <file.local.json>]
//   sst shell --stage poc -- tsx scripts/metrics/simulated-load.ts --load     (operator only)
//
// `--load` writes the rows under the `sim-load` world and publishes the run as the latest of its tab.
// Every customer is synthetic; nothing printed or written carries a phone, an address or a name.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryAnchorLog } from "../../packages/bff/src/complaints/testing";
import { worldMeta } from "../../packages/bff/src/connector/testing";
import type { ComplaintKpi } from "../../packages/bff/src/domain/metrics";
import { writeAnchors } from "../../packages/bff/src/handlers/anchor-writer";
import { type LoadInput, parseLoadInputs } from "../../packages/bff/src/metrics/inputs";
import { decisionCounts } from "../../packages/bff/src/metrics/kpis";
import type { RunRecord } from "../../packages/bff/src/metrics/runs";
import { runPolicyAudit } from "../../packages/bff/src/policy-audit/audit";
import type { PolicyAuditReport } from "../../packages/bff/src/policy-audit/types";
import { parseFlags } from "../channels/cli-args";
import { SIMULATED_LOAD_WORLD } from "../../packages/bff/src/metrics/types";
import { type Pipeline, type PresentationOutcome, createPipeline } from "./pipeline";

const DATA = new URL("../seed/data/", import.meta.url);

export interface SimulatedLoadResult {
  readonly run: RunRecord;
  readonly rows: readonly ComplaintKpi[];
  readonly audit: PolicyAuditReport;
  /** Presentations the deterministic rules classified (the rest would have gone to the model). */
  readonly classifiedByRule: number;
  /** Gate decisions on the acknowledgement and on the written answer, by outcome. */
  readonly outcomes: Readonly<Record<string, number>>;
}

/** The Argentine holidays of the seed's reference (`Reference/HOLIDAY#AR`). */
export function seedHolidays(): string[] {
  const reference = JSON.parse(readFileSync(new URL("reference.json", DATA), "utf8")) as { holidays: { entries: { date: string }[] } };
  return reference.holidays.entries.map((entry) => entry.date);
}

export function seedLoadInputs(path?: string): LoadInput[] {
  return parseLoadInputs(readFileSync(path ?? new URL("load/simulated-complaints.jsonl", DATA), "utf8"));
}

function numberOf(complaintNumber: string): number {
  return Number(complaintNumber.slice(complaintNumber.lastIndexOf("-") + 1));
}

/** First and last number, how many, and the gaps between them. */
export function numberingOf(numbers: readonly string[]): NonNullable<RunRecord["numbering"]> {
  const sorted = [...numbers].sort();
  const values = sorted.map(numberOf);
  const span = values.length === 0 ? 0 : (values.at(-1) ?? 0) - (values[0] ?? 0) + 1;
  return { first: sorted[0] ?? "", last: sorted.at(-1) ?? "", registered: values.length, gaps: span - new Set(values).size };
}

async function milestonesOf(pipeline: Pipeline, outcomes: readonly PresentationOutcome[]): Promise<NonNullable<RunRecord["milestones"]>> {
  const counts = { scheduled: 0, cancelled: 0, fired: 0 };
  for (const outcome of outcomes) {
    if (outcome.complaint === undefined) continue;
    const timers = await pipeline.rig.kit.connector.timers.listByOwner(SIMULATED_LOAD_WORLD, `CMP#${outcome.complaint.complaintId}`);
    for (const timer of timers.filter((candidate) => candidate.kind === "SLA")) {
      counts.scheduled += 1;
      if (timer.status === "CANCELLED") counts.cancelled += 1;
      if (timer.status === "FIRED") counts.fired += 1;
    }
  }
  return counts;
}

async function audit(pipeline: Pipeline): Promise<PolicyAuditReport> {
  const { kit } = pipeline.rig;
  const anchors = new MemoryAnchorLog();
  const now = () => kit.deps.realNow?.() ?? new Date(0);
  for (const request of kit.anchorRequests) await writeAnchors(request, { connector: kit.connector, sink: anchors.sink(), log: kit.log, now });
  return runPolicyAudit({ connector: kit.connector, chainKey: kit.deps.chainKey, anchors, customers: pipeline.rig.deps.customers, log: kit.log, now }, { worldId: SIMULATED_LOAD_WORLD });
}

/** Runs the presentations in filing order and measures the mechanics of the run. */
export async function runSimulatedLoad(options: { readonly inputs: readonly LoadInput[]; readonly holidays: readonly string[]; readonly runId: string; readonly now: Date }): Promise<SimulatedLoadResult> {
  const pipeline = await createPipeline(options.holidays);
  await pipeline.rig.kit.connector.worlds.register(worldMeta(SIMULATED_LOAD_WORLD, { status: "READY" }));
  const ordered = [...options.inputs].sort((a, b) => Date.parse(a.filedAtSim) - Date.parse(b.filedAtSim) || a.id.localeCompare(b.id));
  const outcomes: PresentationOutcome[] = [];
  for (const [index, input] of ordered.entries()) outcomes.push(await pipeline.run(input, index));

  const tally: Record<string, number> = {};
  for (const outcome of outcomes) for (const step of [`ACK_${outcome.ack}`, `ANSWER_${outcome.answer}`]) tally[step] = (tally[step] ?? 0) + 1;
  const { entries: tape } = await pipeline.rig.kit.connector.chains.listTapeBySeq(SIMULATED_LOAD_WORLD, 1, { limit: 100_000 });
  const report = await audit(pipeline);
  const rows: ComplaintKpi[] = outcomes.flatMap((outcome) => (outcome.row === undefined ? [] : [{ ...outcome.row, worldId: SIMULATED_LOAD_WORLD, source: "SIMULATED_LOAD" as const, runId: options.runId }]));
  const run: RunRecord = {
    tab: "SIMULATED_LOAD",
    runId: options.runId,
    worldIds: [SIMULATED_LOAD_WORLD],
    agentMode: "SCRIPTED",
    ranAtReal: options.now.toISOString(),
    inputs: ordered.length,
    policyViolations: report.violations.length,
    decisions: decisionCounts(tape),
    numbering: numberingOf(outcomes.flatMap((outcome) => (outcome.complaint === undefined ? [] : [outcome.complaint.complaintNumber]))),
    milestones: await milestonesOf(pipeline, outcomes),
  };
  return { run, rows, audit: report, classifiedByRule: outcomes.filter((outcome) => outcome.classifiedByRule).length, outcomes: tally };
}

/** Publishes the rows and the run to the stage (`sst shell`: the linked tables). */
async function loadToStage(result: SimulatedLoadResult): Promise<void> {
  const { DynamoStore } = await import("../../packages/bff/src/connector/dynamo/engine");
  const { createConnector } = await import("../../packages/bff/src/connector/create");
  const { publishRun } = await import("../../packages/bff/src/metrics/runs");
  const store = new DynamoStore();
  const connector = createConnector(store);
  for (const row of result.rows) await connector.metrics.put(row);
  await publishRun(store, result.run, new Date());
}

interface CliOptions {
  inputs?: string;
  limit?: number;
  out?: string;
  load: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { load: false };
  parseFlags(argv, {
    "--inputs": (value) => void (options.inputs = value()),
    "--limit": (value) => void (options.limit = Number(value())),
    "--out": (value) => {
      const path = value();
      if (!path.endsWith(".local.json")) throw new RangeError("--out must name a *.local.json file");
      options.out = path;
    },
    "--load": () => void (options.load = true),
  });
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit > 0)) throw new RangeError("--limit must be a positive integer");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const now = new Date();
    const inputs = seedLoadInputs(options.inputs).slice(0, options.limit);
    const result = await runSimulatedLoad({ inputs, holidays: seedHolidays(), runId: `sl-${now.toISOString().slice(0, 10).replaceAll("-", "")}`, now });
    if (options.out) writeFileSync(options.out, `${JSON.stringify({ run: result.run, rows: result.rows }, null, 2)}\n`);
    if (options.load) await loadToStage(result);
    const { numbering, milestones } = result.run;
    console.log(`metrics:simulated-load: ${result.rows.length} complaints, numbers ${numbering?.first}…${numbering?.last} (${numbering?.gaps} gaps), milestones ${milestones?.scheduled} scheduled / ${milestones?.cancelled} cancelled, ${result.run.policyViolations} violations, ${result.classifiedByRule} classified by rule${options.load ? ", loaded" : ""}.`);
  } catch (error) {
    console.error(`metrics:simulated-load: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
