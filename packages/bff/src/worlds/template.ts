// A world template as the factory reads it (`Seed/worlds/<template>.json`, docs/seed-spec.md §1, §4,
// written by `seed:generate` and uploaded by `seed:load`): items with their definitive keys under
// `W#<worldId>#`, the settings (and, for `guest`, the caps picked by the origin of the world id), the
// settlement files and the receipts. The factory substitutes only `<worldId>` and `<epoch>` and
// recomputes what depends on a stage secret (worlds/instantiate.ts).
//
// The world a template builds is decided by the world id alone, never by a request (templateOfWorld).
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { ConnectorError, guestOriginOf, worldKindOf } from "@reclamo/shared";
import { awsClientConfig } from "../lib/clients";
import { withRetry } from "../lib/retry";

export const WORLD_TOKEN = "<worldId>";
export const EPOCH_TOKEN = "<epoch>";

/** Templates the factory builds; `models` is cloned per persona by the QA driver (WP-40). */
export const FactoryTemplate = z.enum(["demo", "guest", "qa-min"]);
export type FactoryTemplate = z.infer<typeof FactoryTemplate>;

/** Tables a template writes (the factory refuses any other). */
export const TemplateTable = z.enum(["Worlds", "Core", "Networks", "Complaints", "Register", "Timers", "Conversations", "ComplianceTape", "AuditLog", "Runtime"]);
export type TemplateTable = z.infer<typeof TemplateTable>;

const TemplateRow = z.object({
  table: TemplateTable,
  pk: z.string().startsWith(`W#${WORLD_TOKEN}#`),
  sk: z.string().min(1).max(512),
  entity: z.string().regex(/^[A-Z][A-Za-z]{1,63}$/),
  data: z.record(z.string(), z.unknown()),
});
export type TemplateRow = z.infer<typeof TemplateRow>;

const SettlementFile = z.object({
  network: z.string().min(1).max(16),
  businessDate: z.string().min(1).max(16),
  status: z.enum(["PUBLISHED", "PENDING"]),
  /** Under `Seed/settlements/<template>/` and `<world root>` in `Settlements` (published batches only). */
  seedPath: z.string().regex(/^[A-Z]+\/\d{4}-\d{2}-\d{2}\/batch-\d+\.csv$/).optional(),
});

export const TemplateDocument = z.object({
  format: z.literal("reclamo-seed-template/1"),
  template: FactoryTemplate,
  startAtSim: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  settingsByOrigin: z.partialRecord(z.enum(["INVITED", "SIGNUP"]), z.record(z.string(), z.unknown())).optional(),
  settlements: z.array(SettlementFile),
  items: z.array(TemplateRow).min(1),
});
export type TemplateDocument = z.infer<typeof TemplateDocument>;

/** Reads a template; the stage reads `Seed/`, `seed:load` and the tests read a local copy. */
export interface TemplateSource {
  read(template: FactoryTemplate): Promise<TemplateDocument>;
}

/** The template a world is built from, by its id (docs/architecture.md §10); `undefined` for QA runs and batches. */
export function templateOfWorld(worldId: string): FactoryTemplate | undefined {
  if (worldId === "demo") return "demo";
  if (worldId === "qamin" || worldId === "gprobe") return "qa-min";
  if (guestOriginOf(worldId) !== undefined) return "guest";
  // A self-signup of the scenario runner (`qa-<runId>-su<n>`, docs/architecture-guests.md §3) gets the guest template.
  if (worldKindOf(worldId) === "QA" && /-su\d+$/.test(worldId)) return "guest";
  return undefined;
}

/** A world of a self-signup: a visitor's `gs-*` or the scenario runner's `qa-<runId>-su<n>` (they provision and expire alike). */
export function isSignupWorld(worldId: string): boolean {
  return guestOriginOf(worldId) === "SIGNUP" || (worldKindOf(worldId) === "QA" && templateOfWorld(worldId) === "guest");
}

/** `worlds/<template>.json` in the `Seed` bucket. */
export function templateSeedKey(template: FactoryTemplate): string {
  return `worlds/${template}.json`;
}

/** `settlements/<template>/<network>/<businessDate>/batch-<n>.csv` in the `Seed` bucket. */
export function settlementSeedKey(template: FactoryTemplate, seedPath: string): string {
  return `settlements/${template}/${seedPath}`;
}

export function parseTemplate(raw: unknown, expected: FactoryTemplate): TemplateDocument {
  const parsed = TemplateDocument.safeParse(raw);
  if (!parsed.success) throw new ConnectorError("VALIDATION", `template ${expected} does not match its format`, "Seed", { cause: parsed.error });
  if (parsed.data.template !== expected) throw new ConnectorError("VALIDATION", `template file of ${expected} holds ${parsed.data.template}`, "Seed");
  return parsed.data;
}

/** Memoizes each template for the life of the container (templates change only with a deploy). */
export function cachedTemplates(source: TemplateSource): TemplateSource {
  const cache = new Map<FactoryTemplate, Promise<TemplateDocument>>();
  return {
    read(template) {
      let pending = cache.get(template);
      if (!pending) {
        pending = source.read(template);
        pending.catch(() => cache.delete(template));
        cache.set(template, pending);
      }
      return pending;
    },
  };
}

// An 8 MB template downloads in a few seconds; past 60 s the bucket is unreachable.
const SEED_READ_TIMEOUTS = { requestTimeoutMs: 60_000, connectionTimeoutMs: 2_000, maxAttempts: 3 } as const;

/** Templates from the `Seed` bucket (capability WORLDS: `Seed` read). */
export function s3TemplateSource(bucket: () => string, client?: S3Client): TemplateSource {
  let s3 = client;
  return cachedTemplates({
    async read(template) {
      s3 ??= new S3Client(awsClientConfig(SEED_READ_TIMEOUTS));
      const s3Client = s3;
      const text = await withRetry(
        async () => {
          const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket(), Key: templateSeedKey(template) }));
          if (!object.Body) throw new ConnectorError("NOT_FOUND", `template ${template} has no body`, "Seed");
          return object.Body.transformToString("utf-8");
        },
        { attempts: 3, baseDelayMs: 200, shouldRetry: (error) => !(error instanceof ConnectorError) },
      );
      return parseTemplate(JSON.parse(text), template);
    },
  });
}

/** Templates already in memory (`seed:load` reads the generated files; the tests build small ones). */
export function memoryTemplateSource(documents: Partial<Record<FactoryTemplate, unknown>>): TemplateSource {
  return {
    async read(template) {
      const raw = documents[template];
      if (raw === undefined) throw new ConnectorError("NOT_FOUND", `template ${template} is not available`, "Seed");
      return parseTemplate(raw, template);
    },
  };
}
