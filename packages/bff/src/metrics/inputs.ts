// The load files of docs/seed-spec.md §13 (inputs, never results), parsed with zod:
//
//   simulated-complaints.jsonl  300 presentations for the simulated load (scripts/metrics/simulated-load.ts)
//   batch-inputs.jsonl          30 presentations, 3 per complaint type, for `batch.run` with the real agent
//
// `batchPlan` is what `batch.run` (the QA driver) creates: one `sim-<runId>` world whose customers are
// clones of the model personas, keyed `b01`…`b30`, so a model persona used twice is two customers.
import { z } from "zod";
import { ComplaintType, PresentationKind, ToolError, WorldId } from "@reclamo/shared";

export const LoadInput = z
  .object({
    id: z.string().regex(/^(sim|batch)-\d{2,3}$/),
    filedAtSim: z.iso.datetime({ offset: true }),
    kind: PresentationKind,
    type: ComplaintType,
    message: z.string().min(1).max(500),
    modelPersona: z.string().regex(/^C\d{2}$/),
    params: z.object({ amountScale: z.number().positive().max(10), networkDelayBusinessDays: z.number().int().min(0).max(10) }).strict(),
    receiptVariant: z.string().regex(/^[a-z-]{1,40}$/).optional(),
  })
  .strict();
export type LoadInput = z.infer<typeof LoadInput>;

/** One line per presentation; a blank line is skipped, anything else that does not parse fails the file. */
export function parseLoadInputs(jsonl: string): LoadInput[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new ToolError("INVALID", `load input line ${index + 1} is not JSON`);
      }
      const parsed = LoadInput.safeParse(raw);
      if (!parsed.success) throw new ToolError("INVALID", `load input line ${index + 1} does not match its schema`);
      return parsed.data;
    });
}

/** Presentations of the real-agent batch and how many per type (docs/seed-spec.md §13). */
export const BATCH_SIZE = 30;
export const BATCH_PER_TYPE = 3;

export interface BatchPersona {
  /** `b01`…`b30`: the persona key `world.create` clones. */
  readonly key: string;
  /** The model persona (`C01`). */
  readonly model: string;
  readonly input: LoadInput;
}

export interface BatchPlan {
  readonly worldId: string;
  readonly personas: readonly BatchPersona[];
}

/** The batch's world and personas; refuses a file that is not 30 complaints, 3 of each of 10 types. */
export function batchPlan(inputs: readonly LoadInput[], runId: string): BatchPlan {
  const worldId = WorldId.parse(`sim-${runId}`);
  if (inputs.length !== BATCH_SIZE) throw new ToolError("INVALID", `a batch has ${BATCH_SIZE} presentations, not ${inputs.length}`);
  const perType = new Map<string, number>();
  for (const input of inputs) {
    if (input.kind !== "RECLAMO") throw new ToolError("INVALID", "a batch holds complaints only");
    perType.set(input.type, (perType.get(input.type) ?? 0) + 1);
  }
  if ([...perType.values()].some((count) => count !== BATCH_PER_TYPE)) throw new ToolError("INVALID", `a batch has ${BATCH_PER_TYPE} presentations of each type`);
  const ordered = [...inputs].sort((a, b) => Date.parse(a.filedAtSim) - Date.parse(b.filedAtSim) || a.id.localeCompare(b.id));
  return { worldId, personas: ordered.map((input, index) => ({ key: `b${String(index + 1).padStart(2, "0")}`, model: input.modelPersona, input })) };
}
