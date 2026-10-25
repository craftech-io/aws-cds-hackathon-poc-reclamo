// `register` router (docs/tool-catalog.md "Procedimientos de la consola", `verify_register_chain`,
// `export_register`; docs/architecture.md §8.3; ADR-0014; FL-096): the complaint register (`REG#`)
// and the refund register (`RRI#`) of the principal's world in its current epoch.
//
//   list     entries in `seq` order (or every entry of one complaint number), paged
//   verify   `verify_register_chain`: the chain recomputed and compared with its anchors, read with
//            `FilterLogEvents` and ordered by `ingestionTime` → `ok`, `partial` (the `seq` without an
//            anchor) or `broken` (`brokenAt`); audited `REGISTER_VERIFIED` with the result
//   export   the whole epoch verified first, then CSV + JSON + `.sha256` to `Exports` under the
//            world's root, each with a 5-minute presigned GET; the header carries the result, the head
//            hash, the published key and every anchor with its stream and `ingestionTime`, so
//            `scripts/register/verify.ts` re-verifies the file without the stage; audited
//            `REGISTER_EXPORTED`. Every CSV cell is guarded against formulas (routers/csv.ts)
//
// The world and the epoch come from the principal and the `META` read for the request, never from
// the input. `exportChain` is shared with `tape.export`.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { ComplaintNumber } from "@reclamo/shared";
import { actorOf } from "../auth/audit";
import { worldObjectRoot } from "../channels/email/config";
import { type AnchorEvent, type AnchorReader, cloudWatchAnchorReader } from "../complaints/anchors";
import { type ChainVerification, type VerifiableEntry, loadChain, verifyChain } from "../complaints/register-verify";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import type { ChainKind } from "../domain/ledger";
import { awsClientConfig } from "../lib/clients";
import { sha256Hex, ulid } from "../lib/crypto";
import { withDeadline } from "../lib/deadline";
import { bucketName } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { keySecret } from "../lib/secrets";
import { type ChainExport, EXPORT_FORMAT, ExportChain, chainExportCsv, chainExportJson } from "./csv";
import type { ContextDeps } from "./deps";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

/** Where the register router reads and writes; tests and the local UI server bind their own. */
export interface RegisterPorts {
  readonly connector: Connector;
  /** The published `RegisterChainKey` (ADR-0014). */
  readonly chainKey: () => string;
  readonly anchors: AnchorReader;
  readonly exports: ExportStore;
}

/** The `Exports` bucket: a put and a 5-minute presigned GET. */
export interface ExportStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  url(key: string, contentType: string): Promise<string>;
}

declare module "./deps" {
  interface ContextDeps {
    /** `register.*` and `tape.export` (routers/register.ts); the linked resources when absent. */
    readonly registerPorts?: RegisterPorts;
  }
}

/** Presigned links of the console live five minutes (docs/architecture.md §11). */
export const PRESIGNED_TTL_SECONDS = 300;

const S3_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;
const PUT_DEADLINE_MS = 8_000;

/** `PutObject` and presigned GET on the linked `Exports` bucket, with a deadline and backoff. */
export function s3ExportStore(client: S3Client = new S3Client(awsClientConfig(S3_TIMEOUTS))): ExportStore {
  return {
    async put(key, body, contentType) {
      const bucket = bucketName("Exports");
      await withDeadline("exports.put", PUT_DEADLINE_MS, (signal) =>
        withRetry(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }), { abortSignal: signal }), {
          attempts: 2,
          baseDelayMs: 100,
          shouldRetry: (error) => error instanceof Error && /Throttl|SlowDown|InternalError|ServiceUnavailable|TimeoutError/.test(error.name),
        }),
      );
    },
    url: (key, contentType) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucketName("Exports"), Key: key, ResponseContentType: contentType }), { expiresIn: PRESIGNED_TTL_SECONDS }),
  };
}

let stagePorts: RegisterPorts | undefined;

export function registerPortsOf(deps: ContextDeps): RegisterPorts {
  if (deps.registerPorts) return deps.registerPorts;
  stagePorts ??= { connector: dynamoConnector(), chainKey: () => keySecret("RegisterChainKey"), anchors: cloudWatchAnchorReader(), exports: s3ExportStore() };
  return stagePorts;
}

/** An `AuditLog` entry of the principal's world; the answer stands when the write fails (logged). */
export async function auditConsole(ctx: WorldContext, connector: Pick<Connector, "audit">, action: string, refs: Record<string, string>, detail?: Record<string, string | number | boolean>): Promise<void> {
  const now = ctx.deps.wallClock();
  try {
    await connector.audit.append({
      worldId: ctx.principal.worldId,
      epoch: ctx.world.epoch,
      auditId: `aud-${ulid(now.getTime()).toLowerCase()}`,
      ts: now.toISOString(),
      action,
      actor: actorOf(ctx.principal),
      refs,
      ...(detail ? { detail } : {}),
    });
  } catch (error) {
    ctx.log.error("console.audit_failed", { action, errorName: error instanceof Error ? error.name : "UnknownError" });
  }
}

function logVerification(ctx: WorldContext, verification: ChainVerification): void {
  const fields = {
    chain: verification.chain,
    epoch: verification.epoch,
    result: verification.result,
    entries: verification.entries,
    brokenAt: verification.brokenAt,
    anchorConflicts: verification.anchorConflicts.length,
    unanchored: verification.unanchored.length,
    foreignAnchors: verification.foreignAnchors.length,
  };
  if (verification.result === "broken") ctx.log.error("register.chain_broken", { metric: "ChainBroken", ...fields });
  else ctx.log.info("register.verified", fields);
}

/** The verification summary the console and the audit show (no entries, no key). */
export function verificationView(verification: ChainVerification) {
  return {
    chain: verification.chain,
    epoch: verification.epoch,
    result: verification.result,
    entries: verification.entries,
    headHash: verification.headHash ?? null,
    brokenAt: verification.brokenAt ?? null,
    breaks: verification.breaks,
    anchorConflicts: verification.anchorConflicts,
    unanchored: verification.unanchored,
    foreignAnchors: verification.foreignAnchors.length,
  };
}

interface LoadedChain {
  readonly entries: VerifiableEntry[];
  readonly anchors: AnchorEvent[];
  readonly verification: ChainVerification;
}

/** One chain of the principal's world and epoch, its anchors and its verification, from one read of each. */
async function loadVerified(ctx: WorldContext, ports: RegisterPorts, chain: ChainKind): Promise<LoadedChain> {
  const { worldId } = ctx.principal;
  const epoch = ctx.world.epoch;
  const [entries, anchors] = await Promise.all([loadChain(ports, worldId, epoch, chain), ports.anchors.read(worldId, epoch)]);
  const verifiable = entries as unknown as VerifiableEntry[];
  const verification = verifyChain({ worldId, epoch, chain, key: ports.chainKey(), entries: verifiable, anchors });
  logVerification(ctx, verification);
  return { entries: verifiable, anchors, verification };
}

const EXPORT_NAMES: Readonly<Record<ChainKind, string>> = { REG: "register", RRI: "refunds", TAPE: "tape" };

/** `2026-10-07T13-10-00-000Z`: an ISO instant usable in an object key. */
function stampOf(now: Date): string {
  return now.toISOString().replaceAll(":", "-").replace(".", "-");
}

export interface ExportedFile {
  readonly key: string;
  readonly url: string;
  readonly sha256: string;
}

/** Verifies one chain and writes its CSV, JSON and `.sha256` to `Exports`; audited `REGISTER_EXPORTED`. */
export async function exportChain(ctx: WorldContext, chain: ChainKind) {
  const ports = registerPortsOf(ctx.deps);
  const { entries, anchors, verification } = await loadVerified(ctx, ports, chain);
  const now = ctx.deps.wallClock();
  const file: ChainExport = {
    header: {
      format: EXPORT_FORMAT,
      worldId: ctx.principal.worldId,
      epoch: ctx.world.epoch,
      chain,
      result: verification.result,
      entries: verification.entries,
      ...(verification.headHash ? { headHash: verification.headHash } : {}),
      ...(verification.brokenAt !== undefined ? { brokenAt: verification.brokenAt } : {}),
      unanchored: [...verification.unanchored],
      anchorConflicts: [...verification.anchorConflicts],
      foreignAnchors: verification.foreignAnchors.length,
      key: ports.chainKey(),
      exportedAtReal: now.toISOString(),
    },
    anchors: anchors.map((anchor) => ({ stream: anchor.stream, ingestionTime: anchor.ingestionTime, message: anchor.message, ...(anchor.timestamp !== undefined ? { timestamp: anchor.timestamp } : {}) })),
    entries: entries.map((entry) => ({ ...entry })),
  };
  const base = `${worldObjectRoot(ctx.principal.worldId)}register/${stampOf(now)}-${EXPORT_NAMES[chain]}-e${ctx.world.epoch}`;
  const csv = chainExportCsv(file);
  const json = chainExportJson(file);
  const sums = { csv: sha256Hex(csv), json: sha256Hex(json) };
  const name = base.slice(base.lastIndexOf("/") + 1);
  const manifest = `${sums.csv}  ${name}.csv\n${sums.json}  ${name}.json\n`;
  const parts = [
    { ext: "csv", body: csv, type: "text/csv; charset=utf-8", sha256: sums.csv },
    { ext: "json", body: json, type: "application/json", sha256: sums.json },
    { ext: "sha256", body: manifest, type: "text/plain; charset=utf-8", sha256: sha256Hex(manifest) },
  ] as const;
  const files: Record<string, ExportedFile> = {};
  for (const part of parts) {
    const key = `${base}.${part.ext}`;
    await ports.exports.put(key, part.body, part.type);
    files[part.ext] = { key, url: await ports.exports.url(key, part.type), sha256: part.sha256 };
  }
  await auditConsole(ctx, ports.connector, "REGISTER_EXPORTED", { chain, result: verification.result, key: `${base}.csv` }, { entries: verification.entries, unanchored: verification.unanchored.length });
  return { ...verificationView(verification), files: files as { csv: ExportedFile; json: ExportedFile; sha256: ExportedFile } };
}

const RegisterChain = z.enum(["REG", "RRI"]);

export const RegisterListInput = z
  .object({
    chain: RegisterChain.optional(),
    complaintNumber: ComplaintNumber.optional(),
    fromSeq: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict()
  .optional();

export const RegisterVerifyInput = z.object({ chain: ExportChain.optional() }).strict().optional();
export const RegisterExportInput = z.object({ chain: RegisterChain.optional() }).strict().optional();

export const registerRouter = router({
  list: accessProcedure("register.list")
    .input(RegisterListInput)
    .query(async ({ ctx, input }) => {
      const { connector } = registerPortsOf(ctx.deps);
      const chain = input?.chain ?? "REG";
      const { worldId } = ctx.principal;
      const epoch = ctx.world.epoch;
      if (input?.complaintNumber !== undefined) {
        const entries = chain === "REG" ? await connector.chains.listRegisterByComplaint(worldId, epoch, input.complaintNumber) : [];
        return { chain, epoch, entries, cursor: null };
      }
      const page = await connector.chains.listRegister(chain, worldId, epoch, {
        limit: input?.limit ?? 100,
        ...(input?.fromSeq !== undefined ? { fromSeq: input.fromSeq } : {}),
        ...(input?.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      return { chain, epoch, entries: page.entries, cursor: page.cursor ?? null };
    }),

  verify: accessProcedure("register.verify")
    .input(RegisterVerifyInput)
    .query(async ({ ctx, input }) => {
      const ports = registerPortsOf(ctx.deps);
      const chain = input?.chain ?? "REG";
      const { verification } = await loadVerified(ctx, ports, chain);
      await auditConsole(ctx, ports.connector, "REGISTER_VERIFIED", { chain, result: verification.result }, { entries: verification.entries });
      return verificationView(verification);
    }),

  export: accessProcedure("register.export")
    .input(RegisterExportInput)
    .query(({ ctx, input }) => exportChain(ctx, input?.chain ?? "REG")),
});
