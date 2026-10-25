/// <reference path="../../sst-env.d.ts" />
// AWS adapters of the QaDriver (docs/architecture.md §14 row `QaDriver`): every resource comes from what SST
// links into the Lambda through lib/resource.ts (never `process.env`), every client has a deadline and the
// SDK's retries (lib/clients.ts), and what IAM answers is reported as the AWS error name, never hidden.
//
//   invoke       request-response invocation of a linked Function (InboundWhatsApp, ScheduleDispatch,
//                WorldJanitor, PolicyAudit), or a direct one of a mock (expected: AccessDenied)
//   dlq, alarm   the QA dead letters and the history of their alarm
//   malware      `GetMalwareProtectionPlan` of the plan of `Media` (signed REST: the SDK has no client here)
//   memory       ListSessions, ListEvents and ListMemoryRecords of an actor
//   objects      server-built images in `Media`, rewritten published files in `Settlements`, Seed reads
import { BedrockAgentCoreClient, ListEventsCommand, ListMemoryRecordsCommand, ListSessionsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DescribeAlarmHistoryCommand, CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { sigV4Signer } from "../core/signer";
import { awsClientConfig } from "../lib/clients";
import { withDeadline } from "../lib/deadline";
import { bucketName, readLinked } from "../lib/resource";
import { QA_REASON } from "./contract";
import type { DeadLetter, MemoryInspector, QaPorts } from "./ports";

const LAMBDA_TIMEOUTS = { requestTimeoutMs: 45_000, connectionTimeoutMs: 1_000, maxAttempts: 1 } as const;
export const SHORT_TIMEOUTS = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;
const S3_TIMEOUTS = { requestTimeoutMs: 30_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

const Named = z.object({ name: z.string().min(1) });
const Url = z.object({ url: z.url() });

let lambda: LambdaClient | undefined;
let s3: S3Client | undefined;
const lambdaClient = () => (lambda ??= new LambdaClient(awsClientConfig(LAMBDA_TIMEOUTS)));
const s3Client = () => (s3 ??= new S3Client(awsClientConfig(S3_TIMEOUTS)));

export function linkedName(link: string): string {
  try {
    return readLinked(link, Named).name;
  } catch (error) {
    throw new ToolError("UNAVAILABLE", `${link} is not linked to the QA driver`, QA_REASON.NOT_WIRED, { cause: error });
  }
}

/** Request-response invocation of a linked Function: its answer, parsed; a function error is reported. */
export async function invokeLinked(link: string, payload: unknown): Promise<unknown> {
  const output = await lambdaClient().send(new InvokeCommand({ FunctionName: linkedName(link), Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
  const text = output.Payload === undefined ? "null" : new TextDecoder().decode(output.Payload);
  if (output.FunctionError !== undefined) throw new ToolError("UNAVAILABLE", `${link} failed (${output.FunctionError})`, "FUNCTION_ERROR");
  return JSON.parse(text) as unknown;
}

export async function errorNameOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "OK";
  } catch (error) {
    return error instanceof Error ? error.name : "unknown";
  }
}

/** A mock invoked directly (not through its Function URL), with a fabricated request context. */
export async function directMockInvoke(target: "CoreMock" | "NetworkMock", worldId: string): Promise<string> {
  let name: string;
  try {
    name = readLinked(target, z.object({ name: z.string().min(1) })).name;
  } catch {
    return "NOT_WIRED";
  }
  const event = { rawPath: `/v1/${worldId}/health`, requestContext: { http: { method: "GET", path: `/v1/${worldId}/health` }, authorizer: { iam: { userArn: "arn:aws:iam::000000000000:role/forged" } } } };
  return errorNameOf(() => lambdaClient().send(new InvokeCommand({ FunctionName: name, Payload: new TextEncoder().encode(JSON.stringify(event)) })));
}

/** A signed `POST` to a mock's Function URL with the driver's own role. */
export async function mockUrlPost(target: "CoreMock" | "NetworkMock", path: string, body: Readonly<Record<string, unknown>>): Promise<{ status: number; reason: string | null }> {
  const url = new URL(path, readLinked(target, Url).url);
  const text = JSON.stringify(body);
  const headers = await sigV4Signer()({ method: "POST", url, headers: { "content-type": "application/json" }, body: text });
  const response = await withDeadline(`${target}.post`, 10_000, (signal) => fetch(url, { method: "POST", headers, body: text, signal, redirect: "error" }));
  const answer = (await response.json().catch(() => undefined)) as { readonly error?: { readonly code?: string; readonly reason?: string } } | undefined;
  return { status: response.status, reason: answer?.error?.reason ?? answer?.error?.code ?? null };
}

/** The Bff's Function URL without the edge header (`probe.edge`). */
export async function bffWithoutEdge(): Promise<{ status: number; reason: string | null }> {
  let base: string;
  try {
    base = readLinked("Bff", Url).url;
  } catch {
    return { status: 0, reason: QA_REASON.NOT_WIRED };
  }
  const response = await withDeadline("bff.edge", 10_000, (signal) => fetch(new URL("api/health", base), { signal, redirect: "error" }));
  const answer = (await response.json().catch(() => undefined)) as { readonly reason?: string; readonly error?: { readonly reason?: string } } | undefined;
  return { status: response.status, reason: answer?.reason ?? answer?.error?.reason ?? null };
}

const DlqBody = z.looseObject({ eventId: z.string(), type: z.string(), worldId: z.string() });

export function stageDlq(): QaPorts["dlq"] {
  const sqs = new SQSClient(awsClientConfig(SHORT_TIMEOUTS));
  const url = () => readLinked("QaCustomerEventsDlq", Url).url;
  const scan = async (eventId: string): Promise<{ letter: DeadLetter; handle: string } | undefined> => {
    for (let round = 0; round < 5; round += 1) {
      const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url(), MaxNumberOfMessages: 10, VisibilityTimeout: 5, WaitTimeSeconds: 1, MessageSystemAttributeNames: ["ApproximateReceiveCount"] }));
      for (const message of page.Messages ?? []) {
        const body = DlqBody.safeParse(JSON.parse(message.Body ?? "null"));
        if (body.success && body.data.eventId === eventId && message.ReceiptHandle !== undefined) {
          const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "0");
          return { letter: { eventId, type: body.data.type, worldId: body.data.worldId, receiveCount }, handle: message.ReceiptHandle };
        }
      }
      if ((page.Messages ?? []).length === 0) return undefined;
    }
    return undefined;
  };
  return {
    find: async (eventId) => (await scan(eventId))?.letter,
    async delete(eventId) {
      const found = await scan(eventId);
      if (found === undefined) return false;
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url(), ReceiptHandle: found.handle }));
      return true;
    },
  };
}

export async function qaDlqAlarmHistory(): Promise<{ at: string; summary: string }[]> {
  const client = new CloudWatchClient(awsClientConfig(SHORT_TIMEOUTS));
  const output = await client.send(new DescribeAlarmHistoryCommand({ AlarmName: linkedName("QaDlqAlarm"), HistoryItemType: "StateUpdate", MaxRecords: 20 }));
  return (output.AlarmHistoryItems ?? []).map((item) => ({ at: item.Timestamp?.toISOString() ?? "", summary: item.HistorySummary ?? "" }));
}

const MalwarePlanLink = z.object({ id: z.string().min(1), arn: z.string().min(1) });
const PlanAnswer = z.looseObject({ status: z.string().optional(), statusReasons: z.array(z.looseObject({ code: z.string().optional(), message: z.string().optional() })).optional() });

/** `GET /malware-protection-plan/{id}` of GuardDuty, signed with the driver's role. */
export async function malwarePlanStatus(): Promise<{ status: string; statusReasons: string[] }> {
  const plan = readLinked("MalwarePlan", MalwarePlanLink);
  const region = plan.arn.split(":")[3] ?? "us-east-1";
  const url = new URL(`https://guardduty.${region}.amazonaws.com/malware-protection-plan/${encodeURIComponent(plan.id)}`);
  const signer = new SignatureV4({ service: "guardduty", region, credentials: defaultProvider(), sha256: Sha256 });
  const signed = await signer.sign({ method: "GET", protocol: url.protocol, hostname: url.hostname, path: url.pathname, query: {}, headers: { host: url.host } });
  const response = await withDeadline("guardduty.plan", 10_000, (signal) => fetch(url, { method: "GET", headers: signed.headers, signal, redirect: "error" }));
  const answer = PlanAnswer.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !answer.success) return { status: `HTTP_${response.status}`, statusReasons: [] };
  return { status: answer.data.status ?? "UNKNOWN", statusReasons: (answer.data.statusReasons ?? []).map((reason) => `${reason.code ?? ""} ${reason.message ?? ""}`.trim()) };
}

export function stageMemoryInspector(): MemoryInspector {
  const client = new BedrockAgentCoreClient(awsClientConfig(SHORT_TIMEOUTS));
  const memoryId = () => readLinked("Agent", z.object({ memoryId: z.string().min(1) })).memoryId;
  const ignoreMissing = <T>(fallback: T) => (error: unknown): T => {
    if (error instanceof Error && error.name === "ResourceNotFoundException") return fallback;
    throw error;
  };
  return {
    sessionIds: async (actorId) => {
      const page = await client.send(new ListSessionsCommand({ memoryId: memoryId(), actorId, maxResults: 100 })).catch(ignoreMissing({ sessionSummaries: [] }));
      return (page.sessionSummaries ?? []).flatMap((session) => (session.sessionId ? [session.sessionId] : []));
    },
    eventCount: async (actorId, sessionId) => {
      const page = await client.send(new ListEventsCommand({ memoryId: memoryId(), actorId, sessionId, includePayloads: false, maxResults: 100 })).catch(ignoreMissing({ events: [] }));
      return (page.events ?? []).length;
    },
    records: async (namespace) => {
      const page = await client.send(new ListMemoryRecordsCommand({ memoryId: memoryId(), namespace, maxResults: 100 })).catch(ignoreMissing({ memoryRecordSummaries: [] }));
      return (page.memoryRecordSummaries ?? []).flatMap((record) =>
        record.memoryRecordId ? [{ memoryRecordId: record.memoryRecordId, createdAt: record.createdAt?.toISOString() ?? "", content: record.content && "text" in record.content ? (record.content.text ?? "") : "" }] : [],
      );
    },
  };
}

export async function seedText(key: string): Promise<string> {
  const object = await s3Client().send(new GetObjectCommand({ Bucket: bucketName("Seed"), Key: key }));
  if (object.Body === undefined) throw new ToolError("NOT_FOUND", `Seed has no ${key}`);
  return object.Body.transformToString("utf-8");
}

export async function seedBytes(key: string): Promise<Uint8Array> {
  const object = await s3Client().send(new GetObjectCommand({ Bucket: bucketName("Seed"), Key: key }));
  if (object.Body === undefined) throw new ToolError("NOT_FOUND", `Seed has no ${key}`);
  return object.Body.transformToByteArray();
}

export const stageObjects: QaPorts["objects"] = {
  async putMedia(key, bytes, contentType) {
    if (!key.startsWith("qa/")) throw new ToolError("FORBIDDEN", "the QA driver writes media only under qa/", "QA_FENCE");
    await s3Client().send(new PutObjectCommand({ Bucket: bucketName("Media"), Key: key, Body: bytes, ContentType: contentType }));
  },
  async putSettlement(key, body) {
    if (!key.startsWith("qa/")) throw new ToolError("FORBIDDEN", "the QA driver writes files only under qa/", "QA_FENCE");
    await s3Client().send(new PutObjectCommand({ Bucket: bucketName("Settlements"), Key: key, Body: body, ContentType: "text/csv; charset=utf-8" }));
  },
};
