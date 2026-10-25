// The world factory by blocks (`create_world`, docs/architecture.md §10): a world built from its template
// in a fixed order, in blocks of at most 200 items, with the position saved after every block
// (`META.buildCursor = {phase, block}`) by the caller's `onBlock`. Every write is idempotent:
//
//   - mutable tables: `PutItem` of the same key (the mocks' items as they are; the BFF entities through
//     their repositories, which add their index attributes; an evidence or action that exists is kept);
//   - `Register`, `ComplianceTape`, `AuditLog`: one conditional `PutItem` per entry (worlds/chains.ts),
//     a different hash stops the build with `FACTORY_CONFLICT`.
//
// So a run cut anywhere resumes from its cursor and ends with the template's manifest, nothing twice
// and nothing missing. A reload (`RELOAD`, a reset) leaves `SETTINGS` as they are.
import { ConnectorError } from "@reclamo/shared";
import { isConflict } from "../connector/errors";
import type { WriteOp } from "../connector/store";
import type { BuildCursor } from "../domain/world";
import { appendAuditBlock, appendChainBlock } from "./chains";
import { type Budget, type WorldsDeps, outOfTime } from "./deps";
import type { Modeled, WorldBuild } from "./instantiate";

export const BUILD_PHASES = ["SETTINGS", "CORE", "NETWORKS", "FILES", "COMPLAINTS", "TIMERS", "CONVERSATIONS", "RUNTIME", "REG", "RRI", "TAPE", "AUDIT"] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];

/** Items per block (docs/architecture.md §10). */
export const BLOCK_SIZE = 200;

/** Writes of one block that run side by side (DynamoDB answers each in milliseconds). */
const CONCURRENCY = 8;

export type BuildMode = "CREATE" | "RELOAD";

export interface WriteWorldRequest {
  readonly build: WorldBuild;
  readonly mode: BuildMode;
  /** Where a previous run stopped; the start when absent. */
  readonly cursor?: BuildCursor;
  readonly budget: Budget;
  /** Persists the position after a block (and renews the lease); runs before the next block. */
  readonly onBlock: (next: BuildCursor) => Promise<void>;
}

export type WriteWorldResult = { readonly done: true } | { readonly done: false; readonly cursor: BuildCursor };

type FactoryDeps = Pick<WorldsDeps, "connector" | "store" | "objects" | "anchors" | "log" | "keys">;

function sizeOf(build: WorldBuild, phase: BuildPhase): number {
  switch (phase) {
    case "SETTINGS":
      return 1;
    case "CORE":
      return build.core.length;
    case "NETWORKS":
      return build.networks.length;
    case "FILES":
      return build.files.length;
    case "COMPLAINTS":
      return build.complaints.length;
    case "TIMERS":
      return build.timers.length;
    case "CONVERSATIONS":
      return build.conversations.length;
    case "RUNTIME":
      return build.runtime.length + 1;
    case "REG":
    case "RRI":
    case "TAPE":
      return build.chains[phase].length;
    case "AUDIT":
      return build.audit.length;
  }
}

/** Blocks of a phase (an empty phase still has one, so the cursor walks every phase the same way). */
export function blocksOf(build: WorldBuild, phase: BuildPhase): number {
  return Math.max(1, Math.ceil(sizeOf(build, phase) / BLOCK_SIZE));
}

/** The position after `cursor`: the next block of the phase, or the first block of the next phase. */
export function nextCursor(build: WorldBuild, cursor: BuildCursor): BuildCursor | undefined {
  if (cursor.block + 1 < blocksOf(build, cursor.phase as BuildPhase)) return { phase: cursor.phase, block: cursor.block + 1 };
  const next = BUILD_PHASES[BUILD_PHASES.indexOf(cursor.phase as BuildPhase) + 1];
  return next === undefined ? undefined : { phase: next, block: 0 };
}

async function inParallel<T>(values: readonly T[], run: (value: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < values.length; start += CONCURRENCY) await Promise.all(values.slice(start, start + CONCURRENCY).map(run));
}

function modeledOp(deps: FactoryDeps, row: Modeled): WriteOp {
  const { connector } = deps;
  const data = row.data as never;
  switch (row.entity) {
    case "Complaint":
      return connector.complaints.createOp(data, { replace: true });
    case "Approval":
      return connector.caseItems.restoreApprovalOp(data);
    case "Evidence":
      return connector.caseItems.putEvidenceOp(data);
    case "Action":
      return connector.caseItems.putActionOp(data);
    case "Execution":
      return connector.caseItems.putExecutionOp(data, { replace: true });
    case "Timer":
      return connector.timers.putOp(data, { replace: true });
    case "ConversationMeta":
      return connector.conversations.createOp(data, { replace: true });
    case "Message":
      return connector.conversations.putMessageOp(data, { replace: true });
    default:
      throw new ConnectorError("VALIDATION", `the factory does not write ${row.entity}`, "Seed");
  }
}

/** Writes a modeled entity; an immutable one (evidence, action) that already exists is the same one. */
async function writeModeled(deps: FactoryDeps, row: Modeled): Promise<void> {
  try {
    await deps.connector.write(modeledOp(deps, row));
  } catch (error) {
    if (!(isConflict(error) && (row.entity === "Evidence" || row.entity === "Action"))) throw error;
  }
}

async function writeSettings(deps: FactoryDeps, build: WorldBuild, mode: BuildMode): Promise<void> {
  if (mode === "RELOAD") return;
  try {
    await deps.connector.worlds.putSettings(build.settings as never);
  } catch (error) {
    // A world that already has its settings keeps them (a resumed run, an operator's change).
    if (!isConflict(error)) throw error;
  }
}

async function writeBlock(deps: FactoryDeps, build: WorldBuild, mode: BuildMode, phase: BuildPhase, block: number): Promise<void> {
  const from = block * BLOCK_SIZE;
  const to = from + BLOCK_SIZE;
  const { worldItems } = deps.connector;
  switch (phase) {
    case "SETTINGS":
      return writeSettings(deps, build, mode);
    case "CORE":
      if (build.core.length > 0) await worldItems.put("Core", build.worldId, build.core.slice(from, to));
      return;
    case "NETWORKS":
      if (build.networks.length > 0) await worldItems.put("Networks", build.worldId, build.networks.slice(from, to));
      return;
    case "FILES":
      return inParallel(build.files.slice(from, to), (file) => deps.objects.copySettlement(file.seedKey, file.key));
    case "COMPLAINTS":
      return inParallel(build.complaints.slice(from, to), (row) => writeModeled(deps, row));
    case "TIMERS":
      return inParallel(build.timers.slice(from, to), (row) => writeModeled(deps, row));
    case "CONVERSATIONS":
      return inParallel(build.conversations.slice(from, to), (row) => writeModeled(deps, row));
    case "RUNTIME":
      // The world's clock (PAUSED at the template's start, `worldEpoch` of this build) and its counters.
      if (block === 0) await deps.connector.runtime.putClock({ ...build.clock, worldId: build.worldId, worldEpoch: build.epoch } as never);
      if (build.runtime.length > 0) await worldItems.put("Runtime", build.worldId, build.runtime.slice(from, to));
      return;
    case "REG":
    case "RRI":
    case "TAPE":
      return appendChainBlock(deps, build, phase, deps.keys().chainKey, from, to);
    case "AUDIT":
      return appendAuditBlock(deps, build, from, to);
  }
}

function validCursor(build: WorldBuild, cursor: BuildCursor | undefined): BuildCursor {
  if (cursor === undefined) return { phase: BUILD_PHASES[0], block: 0 };
  if (!(BUILD_PHASES as readonly string[]).includes(cursor.phase)) throw new ConnectorError("VALIDATION", `unknown build phase ${cursor.phase}`, "Worlds");
  return { phase: cursor.phase, block: Math.min(cursor.block, blocksOf(build, cursor.phase as BuildPhase) - 1) };
}

/** Writes the world from `cursor` on until it is complete or the budget runs out (see the header). */
export async function writeWorld(deps: FactoryDeps, request: WriteWorldRequest): Promise<WriteWorldResult> {
  let cursor: BuildCursor | undefined = validCursor(request.build, request.cursor);
  while (cursor !== undefined) {
    if (outOfTime(request.budget)) return { done: false, cursor };
    await writeBlock(deps, request.build, request.mode, cursor.phase as BuildPhase, cursor.block);
    const next = nextCursor(request.build, cursor);
    if (next !== undefined) await request.onBlock(next);
    cursor = next;
  }
  deps.log.info("worlds.written", { worldId: request.build.worldId, epoch: request.build.epoch, template: request.build.template, mode: request.mode });
  return { done: true };
}

/** Total blocks of a build, for the progress a caller reports. */
export function totalBlocks(build: WorldBuild): number {
  return BUILD_PHASES.reduce((sum, phase) => sum + blocksOf(build, phase), 0);
}
