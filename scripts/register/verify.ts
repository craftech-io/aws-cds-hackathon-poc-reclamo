// Independent verification of a chain export (ADR-0014, docs/architecture.md §8.3, FL-096): anyone
// holding the file (CSV or JSON from `register.export` / `tape.export`) re-verifies it WITHOUT access
// to the stage, with the same code the console runs (packages/bff/src/complaints/register-verify.ts):
// every hash recomputed with the key the export publishes, every anchor taken by `ingestionTime` (the
// first ingested one of each `seq` in the exact stream counts; two that disagree are a break), a `seq`
// without an anchor leaves the result `partial`, never `ok`.
//
//   npm run register:verify -- <export.csv|export.json>                    the `.sha256` next to it, if any, is checked too
//   npm run register:verify -- <export.csv> --sha256 <export.sha256>
//
// It prints the recomputed result next to the one the header declares, and never the key. Exit codes:
// 0 `ok` and consistent · 3 `partial` and consistent · 1 `broken`, a header that does not match the
// recomputation or a `.sha256` that does not match the file · 2 a file that is not an export.
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { type ChainVerification, type VerifiableEntry, verifyChain } from "../../packages/bff/src/complaints/register-verify";
import { type ChainExport, parseChainExport } from "../../packages/bff/src/routers/csv";
import { parseFlags } from "../channels/cli-args";

export interface ExportReport {
  readonly chain: ChainExport["header"]["chain"];
  readonly worldId: string;
  readonly epoch: number;
  readonly entries: number;
  /** What the file says. */
  readonly declared: ChainExport["header"]["result"];
  /** What this verification found. */
  readonly recomputed: ChainVerification["result"];
  /** Result, head hash, broken `seq`, unanchored and conflicting `seq` all as declared. */
  readonly consistent: boolean;
  readonly brokenAt: number | null;
  readonly unanchored: readonly number[];
  readonly anchorConflicts: readonly number[];
  readonly foreignAnchors: number;
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Verifies the content of an export (either form). Throws when it is not an export. */
export function verifyExport(content: string): ExportReport {
  const file = parseChainExport(content);
  const { header } = file;
  const verification = verifyChain({
    worldId: header.worldId,
    epoch: header.epoch,
    chain: header.chain,
    key: header.key,
    entries: file.entries as unknown as VerifiableEntry[],
    anchors: file.anchors,
  });
  const consistent =
    verification.result === header.result &&
    verification.entries === header.entries &&
    (verification.headHash ?? undefined) === header.headHash &&
    verification.brokenAt === header.brokenAt &&
    sameList(verification.unanchored, header.unanchored) &&
    sameList(verification.anchorConflicts, header.anchorConflicts);
  return {
    chain: header.chain,
    worldId: header.worldId,
    epoch: header.epoch,
    entries: verification.entries,
    declared: header.result,
    recomputed: verification.result,
    consistent,
    brokenAt: verification.brokenAt ?? null,
    unanchored: verification.unanchored,
    anchorConflicts: verification.anchorConflicts,
    foreignAnchors: verification.foreignAnchors.length,
  };
}

/** Whether a `sha256sum`-style manifest lists `name` with the SHA-256 of `content`; `undefined` when it does not list it. */
export function checkManifest(manifest: string, name: string, content: string | Buffer): boolean | undefined {
  const line = manifest
    .split(/\r?\n/)
    .map((row) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(row.trim()))
    .find((match) => match?.[2] === name);
  if (!line?.[1]) return undefined;
  return createHash("sha256").update(content).digest("hex") === line[1];
}

/** 0 ok · 3 partial · 1 broken, inconsistent or a manifest mismatch. */
export function exitCodeOf(report: ExportReport, manifestOk: boolean | undefined): number {
  if (manifestOk === false || !report.consistent || report.recomputed === "broken") return 1;
  return report.recomputed === "partial" ? 3 : 0;
}

export function describe(report: ExportReport, manifestOk: boolean | undefined): string[] {
  const lines = [
    `chain ${report.chain} · world ${report.worldId} · epoch ${report.epoch} · ${report.entries} entries`,
    `result: ${report.recomputed} (declared: ${report.declared}) · header ${report.consistent ? "consistent" : "INCONSISTENT"}`,
  ];
  if (report.brokenAt !== null) lines.push(`broken at seq ${report.brokenAt}`);
  if (report.unanchored.length > 0) lines.push(`without anchor (unverified): seq ${report.unanchored.join(", ")}`);
  if (report.anchorConflicts.length > 0) lines.push(`anchor conflicts: seq ${report.anchorConflicts.join(", ")}`);
  if (report.foreignAnchors > 0) lines.push(`anchors in foreign streams ignored: ${report.foreignAnchors}`);
  if (manifestOk !== undefined) lines.push(`sha256 manifest: ${manifestOk ? "matches" : "DOES NOT MATCH"}`);
  return lines;
}

export interface VerifyArgs {
  readonly file: string;
  readonly sha256?: string;
}

export function parseVerifyArgs(argv: readonly string[]): VerifyArgs {
  const [file, ...rest] = argv;
  if (file === undefined || file.startsWith("--")) throw new RangeError("usage: register:verify -- <export.csv|export.json> [--sha256 <manifest>]");
  let sha256: string | undefined;
  parseFlags(rest, {
    "--sha256": (value) => {
      sha256 = value();
    },
  });
  return { file, ...(sha256 === undefined ? {} : { sha256 }) };
}

/** The manifest given, or the `<base>.sha256` written next to the export. */
function manifestPathOf(args: VerifyArgs): string | undefined {
  if (args.sha256 !== undefined) return args.sha256;
  const sibling = args.file.replace(/\.(csv|json)$/, ".sha256");
  return sibling !== args.file && existsSync(sibling) ? sibling : undefined;
}

export function run(argv: readonly string[], print: (line: string) => void = console.log): number {
  let args: VerifyArgs;
  let report: ExportReport;
  let content: string;
  try {
    args = parseVerifyArgs(argv);
    content = readFileSync(resolve(args.file), "utf8");
    report = verifyExport(content);
  } catch (error) {
    print(`not a chain export: ${error instanceof Error ? error.message.split("\n")[0] : "unreadable"}`);
    return 2;
  }
  const manifestPath = manifestPathOf(args);
  const manifestOk = manifestPath === undefined ? undefined : (checkManifest(readFileSync(resolve(manifestPath), "utf8"), basename(args.file), content) ?? false);
  for (const line of describe(report, manifestOk)) print(line);
  return exitCodeOf(report, manifestOk);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
