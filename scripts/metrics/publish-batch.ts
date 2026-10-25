// Publishes a real-agent batch (`batch.run` of the QA driver, docs/tool-catalog.md) as the latest of the
// "Lote · agente real" tab: reads the KPI rows, the tape decisions and the PolicyAudit findings of the
// batch's `sim-*` worlds and writes `Reference/REF#METRICS_RUN#BATCH` / `LATEST` (metrics/runs.ts). The
// tab then shows the raw figure and the one weighted by the assumed type mix (metrics/kpis.ts).
//
//   sst shell --stage poc -- tsx scripts/metrics/publish-batch.ts --run <runId> --world sim-<runId> [--report-cost <usd>]
//
// Operator only (it writes `Reference`); it never runs the batch and never calls Bedrock.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldId } from "@reclamo/shared";
import { RUN_WORLD_PREFIX } from "../../packages/bff/src/metrics/types";
import { parseFlags } from "../channels/cli-args";

export interface PublishOptions {
  readonly runId: string;
  readonly worldIds: readonly string[];
  readonly reportCostUsd?: number;
}

export function parsePublishArgs(argv: readonly string[]): PublishOptions {
  let runId: string | undefined;
  let reportCostUsd: number | undefined;
  const worldIds: string[] = [];
  parseFlags(argv, {
    "--run": (value) => void (runId = value()),
    "--world": (value) => {
      const worldId = value();
      if (!worldId.startsWith(RUN_WORLD_PREFIX) || !WorldId.safeParse(worldId).success) throw new RangeError("--world must name a sim-* world");
      worldIds.push(worldId);
    },
    "--report-cost": (value) => {
      reportCostUsd = Number(value());
      if (!Number.isFinite(reportCostUsd) || reportCostUsd < 0) throw new RangeError("--report-cost must be a non-negative number of USD");
    },
  });
  if (runId === undefined || worldIds.length === 0) throw new RangeError("pass --run and at least one --world");
  return { runId, worldIds, ...(reportCostUsd === undefined ? {} : { reportCostUsd }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parsePublishArgs(process.argv.slice(2));
    const { DynamoStore } = await import("../../packages/bff/src/connector/dynamo/engine");
    const { createConnector } = await import("../../packages/bff/src/connector/create");
    const { collectBatchRun, publishRun } = await import("../../packages/bff/src/metrics/runs");
    const store = new DynamoStore();
    const now = new Date();
    const run = await collectBatchRun(createConnector(store), { ...options, now });
    await publishRun(store, run, now);
    console.log(`metrics:publish-batch: ${run.runId} published with ${run.inputs} complaints and ${run.policyViolations} violations.`);
  } catch (error) {
    console.error(`metrics:publish-batch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
