// `emails` router (docs/tool-catalog.md "Procedimientos de la consola"; docs/design-brief.md §9
// "Emails"; FL-093): every email the world sent, exactly as it left. The `.eml` in `Emails` is the raw
// MIME handed to SES and the `.json` next to it the view the outbound client rendered from the same
// parts (channels/email/store.ts); both were written before `SendEmail`.
//
//   list           the world's emails, newest first (index `EmailIndex`), recipient masked
//   get            headers, text, HTML, attachments and SES events of one email, plus the SHA-256 of
//                  the `.eml` read now next to the one recorded at send time (`integrity.matches`)
//   attachmentUrl  a 5-minute presigned GET of one attached PDF in `Documents`, with its content type
//                  fixed by the code; the console downloads it with `fetch()` into a `blob:` URL
//
// The console shows the HTML in an `iframe sandbox` without scripts (`srcdoc`); this router never
// returns an address in clear, and every key it reads is under the principal's world root.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { PDF_CONTENT_TYPE, worldObjectRoot } from "../channels/email/config";
import { dynamoConnector } from "../connector/dynamo/connector";
import type { Connector } from "../connector/port";
import { CustomerId, Id } from "../domain/common";
import type { EmailRecord } from "../domain/conversation";
import { awsClientConfig } from "../lib/clients";
import { sha256Hex } from "../lib/crypto";
import { withDeadline } from "../lib/deadline";
import { bucketName } from "../lib/resource";
import type { ContextDeps } from "./deps";
import { PRESIGNED_TTL_SECONDS } from "./register";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

/** `Emails` objects and `Documents` links; tests and the local UI server bind their own. */
export interface EmailsPorts {
  readonly connector: Connector;
  /** The bytes of an object of `Emails`; `undefined` when it does not exist. */
  readonly emailObject: (key: string) => Promise<Uint8Array | undefined>;
  /** A 5-minute presigned GET of a PDF of `Documents`. */
  readonly documentUrl: (key: string, filename: string) => Promise<string>;
}

declare module "./deps" {
  interface ContextDeps {
    /** `emails.*` (routers/emails.ts); the linked resources when absent. */
    readonly emailsPorts?: EmailsPorts;
  }
}

const S3_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;
const GET_DEADLINE_MS = 8_000;

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

/** `GetObject` on `Emails` and presigned GET on `Documents`, over the linked buckets. */
export function s3EmailsObjects(client: S3Client = new S3Client(awsClientConfig(S3_TIMEOUTS))): Pick<EmailsPorts, "emailObject" | "documentUrl"> {
  return {
    async emailObject(key) {
      const bucket = bucketName("Emails");
      try {
        const output = await withDeadline("emails.get", GET_DEADLINE_MS, (signal) => client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal }));
        return output.Body ? await output.Body.transformToByteArray() : undefined;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    documentUrl: (key, filename) =>
      getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucketName("Documents"), Key: key, ResponseContentType: PDF_CONTENT_TYPE, ResponseContentDisposition: `attachment; filename="${filename}"` }),
        { expiresIn: PRESIGNED_TTL_SECONDS },
      ),
  };
}

let stagePorts: EmailsPorts | undefined;

function emailsPortsOf(deps: ContextDeps): EmailsPorts {
  if (deps.emailsPorts) return deps.emailsPorts;
  stagePorts ??= { connector: dynamoConnector(), ...s3EmailsObjects() };
  return stagePorts;
}

/** The `.json` view of channels/email/store.ts, read back with zod (a stored object is an edge too). */
export const EmailViewFile = z.object({
  mailId: z.string(),
  worldId: z.string(),
  headers: z.object({ from: z.string(), toMasked: z.string(), subject: z.string(), date: z.string() }),
  text: z.string(),
  html: z.string(),
  attachments: z.array(z.object({ filename: z.string().regex(/^[A-Za-z0-9._-]{1,100}\.pdf$/), docKind: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })),
  rawSha256: z.string(),
});
export type EmailViewFile = z.infer<typeof EmailViewFile>;

const EmailRef = { customerId: CustomerId, mailId: Id };
export const EmailsListInput = z.object({ limit: z.number().int().min(1).max(200).optional(), cursor: z.string().min(1).max(2_048).optional() }).strict().optional();
export const EmailGetInput = z.object(EmailRef).strict();
export const AttachmentUrlInput = z.object({ ...EmailRef, index: z.number().int().min(0).max(9) }).strict();

function underWorld(ctx: WorldContext, key: string): boolean {
  return key.startsWith(worldObjectRoot(ctx.principal.worldId)) && !key.includes("..");
}

async function recordOf(ctx: WorldContext, ports: EmailsPorts, customerId: string, mailId: string): Promise<EmailRecord> {
  const record = await ports.connector.emails.find(ctx.principal.worldId, customerId, mailId);
  if (record === undefined) throw new ToolError("NOT_FOUND", "there is no such email in this world", "EMAIL_NOT_FOUND");
  return record;
}

async function viewOf(ctx: WorldContext, ports: EmailsPorts, record: EmailRecord): Promise<EmailViewFile | null> {
  if (record.s3RenderKey === undefined || !underWorld(ctx, record.s3RenderKey)) return null;
  const bytes = await ports.emailObject(record.s3RenderKey);
  if (bytes === undefined) return null;
  const parsed = EmailViewFile.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success) {
    ctx.log.error("emails.view_invalid", { mailId: record.mailId });
    return null;
  }
  return parsed.data;
}

function summaryOf(record: EmailRecord) {
  return {
    mailId: record.mailId,
    customerId: record.customerId,
    complaintId: record.complaintId ?? null,
    kind: record.kind,
    toMasked: record.toMasked,
    subject: record.subject,
    sentAtSim: record.sentAtSim,
    deliveryProof: record.deliveryProof ?? null,
    attachments: record.attachments.length,
    lastEvent: record.events.at(-1)?.type ?? null,
  };
}

export const emailsRouter = router({
  list: accessProcedure("emails.list")
    .input(EmailsListInput)
    .query(async ({ ctx, input }) => {
      const { connector } = emailsPortsOf(ctx.deps);
      const page = await connector.emails.listWorld(ctx.principal.worldId, { limit: input?.limit ?? 50, ...(input?.cursor !== undefined ? { cursor: input.cursor } : {}) });
      return { emails: page.emails.map(summaryOf), cursor: page.cursor ?? null };
    }),

  get: accessProcedure("emails.get")
    .input(EmailGetInput)
    .query(async ({ ctx, input }) => {
      const ports = emailsPortsOf(ctx.deps);
      const record = await recordOf(ctx, ports, input.customerId, input.mailId);
      const raw = underWorld(ctx, record.s3RawKey) ? await ports.emailObject(record.s3RawKey) : undefined;
      const view = await viewOf(ctx, ports, record);
      const sha256 = raw === undefined ? null : sha256Hex(raw);
      const recorded = record.rawSha256 ?? view?.rawSha256 ?? null;
      return {
        ...summaryOf(record),
        /** Real instant the record was written when the email left: SES stamps its events on this clock. */
        sentAtReal: record.createdAt ?? null,
        view,
        events: record.events,
        integrity: { sha256, recorded, matches: sha256 !== null && sha256 === recorded, bytes: raw?.byteLength ?? null },
      };
    }),

  attachmentUrl: accessProcedure("emails.attachmentUrl")
    .input(AttachmentUrlInput)
    .query(async ({ ctx, input }) => {
      const ports = emailsPortsOf(ctx.deps);
      const record = await recordOf(ctx, ports, input.customerId, input.mailId);
      const attachment = record.attachments[input.index];
      if (attachment === undefined || !underWorld(ctx, attachment.s3Key)) throw new ToolError("NOT_FOUND", "this email has no such attachment", "ATTACHMENT_NOT_FOUND");
      const filename = `${attachment.docKind.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${input.index + 1}.pdf`;
      return { url: await ports.documentUrl(attachment.s3Key, filename), contentType: PDF_CONTENT_TYPE, sha256: attachment.sha256, expiresInSeconds: PRESIGNED_TTL_SECONDS };
    }),
});
