// The S3 of the local UI server (docs/test-plan.md §2, level UI): the browser's presigned POST of the
// phone simulator lands here and is checked the way S3 checks it — SigV4 signature of the policy with
// the emulator's credentials, expiration, and EVERY condition (bucket, exact key, content type, size
// range), with any form field no condition names refused — before the object is stored in the world's
// `Media`. A GET of `/s3/<bucket>/<key>` serves an object of the world (the console's 5-minute links).
// The presigner signs for this emulator with the same conditions as the stage's
// (`routers/simulator.ts` `s3UploadPresigner`). Nothing here ever reaches AWS.
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { MAX_MEDIA_BYTES } from "@reclamo/bff/channels/whatsapp/config";
import type { SimulatorPorts } from "@reclamo/bff/routers/simulator";
import type { FakeS3 } from "../flows/support/fakes/s3";
import { readBody } from "./lambda-bridge";

export const EMULATOR_REGION = "us-east-1";
/** Credentials of the emulator only: no account has them. */
export const EMULATOR_CREDENTIALS = { accessKeyId: "AKIDLOCALS3EMULATOR0", secretAccessKey: "local-s3-emulator-secret-not-a-secret-0123" } as const;
/** How long a presigned POST lives (the stage's `PRESIGNED_TTL_SECONDS`). */
export const UPLOAD_TTL_SECONDS = 300;
const PREFIX = "/s3/";

export type PostVerdict =
  | { readonly ok: true; readonly bucket: string; readonly key: string; readonly bytes: Uint8Array; readonly contentType: string }
  | { readonly ok: false; readonly status: number; readonly code: string };

type Condition = Readonly<Record<string, string>> | readonly [string, string | number, string | number];

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** SigV4's signature of a POST policy (`AWS4-HMAC-SHA256`, service `s3`). */
export function policySignature(secret: string, date: string, region: string, policy: string): string {
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
  return createHmac("sha256", signingKey).update(policy).digest("hex");
}

function refused(status: number, code: string): PostVerdict {
  return { ok: false, status, code };
}

function fieldOf(form: FormData, name: string): string | undefined {
  for (const [field, value] of form.entries()) if (field.toLowerCase() === name.toLowerCase() && typeof value === "string") return value;
  return undefined;
}

/** S3's checks of a browser POST, in its order; `now` is the real instant of the request. */
export async function verifyPost(form: FormData, bucket: string, now: Date): Promise<PostVerdict> {
  const policyB64 = fieldOf(form, "policy");
  const signature = fieldOf(form, "x-amz-signature");
  const credential = fieldOf(form, "x-amz-credential") ?? "";
  const file = form.get("file");
  if (policyB64 === undefined || signature === undefined || !(file instanceof Blob)) return refused(400, "InvalidArgument");
  const [accessKeyId, date = "", region = ""] = credential.split("/");
  if (accessKeyId !== EMULATOR_CREDENTIALS.accessKeyId || fieldOf(form, "x-amz-algorithm") !== "AWS4-HMAC-SHA256") return refused(403, "InvalidAccessKeyId");
  if (policySignature(EMULATOR_CREDENTIALS.secretAccessKey, date, region, policyB64) !== signature) return refused(403, "SignatureDoesNotMatch");
  let policy: { expiration?: unknown; conditions?: unknown };
  try {
    policy = JSON.parse(Buffer.from(policyB64, "base64").toString("utf8")) as typeof policy;
  } catch {
    return refused(400, "InvalidPolicyDocument");
  }
  if (typeof policy.expiration !== "string" || Date.parse(policy.expiration) <= now.getTime()) return refused(403, "AccessDenied");
  const conditions = Array.isArray(policy.conditions) ? (policy.conditions as Condition[]) : [];
  const bytes = new Uint8Array(await file.arrayBuffer());
  const named = new Set<string>();
  for (const condition of conditions) {
    if (Array.isArray(condition)) {
      const [operator, target, value] = condition;
      if (operator === "content-length-range") {
        if (bytes.byteLength < Number(target) || bytes.byteLength > Number(value)) return refused(400, "EntityTooLarge");
        continue;
      }
      const name = String(target).replace(/^\$/, "").toLowerCase();
      named.add(name);
      const actual = name === "bucket" ? bucket : fieldOf(form, name);
      if (operator === "eq" && actual !== value) return refused(403, "AccessDenied");
      if (operator === "starts-with" && !(actual ?? "").startsWith(String(value))) return refused(403, "AccessDenied");
      if (operator !== "eq" && operator !== "starts-with") return refused(400, "InvalidPolicyDocument");
      continue;
    }
    for (const [name, value] of Object.entries(condition)) {
      named.add(name.toLowerCase());
      const actual = name.toLowerCase() === "bucket" ? bucket : fieldOf(form, name);
      if (actual !== value) return refused(403, "AccessDenied");
    }
  }
  for (const [field] of form.entries()) {
    const name = field.toLowerCase();
    if (["file", "policy", "x-amz-signature"].includes(name) || name.startsWith("x-ignore-")) continue;
    if (!named.has(name)) return refused(403, "AccessDenied");
  }
  const key = fieldOf(form, "key");
  if (key === undefined || key.length === 0) return refused(400, "InvalidArgument");
  return { ok: true, bucket, key, bytes, contentType: fieldOf(form, "content-type") ?? "application/octet-stream" };
}

/** The simulator's presigned POST, signed for this emulator with the stage's conditions. */
export function emulatorUploadPresigner(origin: string): SimulatorPorts["presignUpload"] {
  const client = new S3Client({ region: EMULATOR_REGION, endpoint: `${origin}/s3`, forcePathStyle: true, credentials: EMULATOR_CREDENTIALS });
  return (key, contentType) =>
    createPresignedPost(client, {
      Bucket: "Media",
      Key: key,
      Fields: { "Content-Type": contentType },
      Conditions: [["content-length-range", 1, MAX_MEDIA_BYTES], ["eq", "$Content-Type", contentType], ["eq", "$key", key]],
      Expires: UPLOAD_TTL_SECONDS,
    });
}

/** The browser's URL of an object of a world's bucket (presigned GETs of the console). */
export function emulatorObjectUrl(origin: string, bucket: string, key: string): string {
  return `${origin}${PREFIX}${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Answers `/s3/<bucket>` (POST) and `/s3/<bucket>/<key>` (GET); anything else is 405. */
export async function handleS3(request: IncomingMessage, response: ServerResponse, s3: FakeS3, now: Date): Promise<void> {
  const url = new URL(request.url ?? "/", "http://ui-server.local");
  const [bucket = "", ...keyParts] = url.pathname.slice(PREFIX.length).split("/");
  if (request.method === "GET" && keyParts.length > 0) {
    const object = s3.get(bucket, keyParts.map(decodeURIComponent).join("/"));
    if (object === undefined) {
      response.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    response.writeHead(200, { "content-type": object.contentType, "cache-control": "no-store" }).end(Buffer.from(object.bytes));
    return;
  }
  if (request.method !== "POST" || keyParts.some((part) => part.length > 0)) {
    response.writeHead(405).end();
    return;
  }
  const body = await readBody(request);
  const form = await new Request(url, { method: "POST", headers: { "content-type": request.headers["content-type"] ?? "" }, body: new Uint8Array(body) }).formData();
  const verdict = await verifyPost(form, bucket, now);
  if (!verdict.ok) {
    response.writeHead(verdict.status, { "content-type": "application/xml" }).end(`<Error><Code>${verdict.code}</Code></Error>`);
    return;
  }
  s3.put(verdict.bucket, verdict.key, verdict.bytes, verdict.contentType);
  response.writeHead(204, { "access-control-allow-origin": url.origin }).end();
}
