// `fence.probe({kind: WORLD_PATHS})` (docs/tool-catalog.md, docs/architecture.md §14 "Cerca del QaDriver",
// FL-109, SC-18/10): the four ways the QaDriver could reach a guest world THROUGH another Lambda, tried
// against `gprobe` (a guest-class world nobody uses), each one expected to be refused by that Lambda,
// with a hash of `gprobe` read before and after (its IAM lets the driver only read it):
//
//   a  InboundWhatsApp   a valid envelope signed with `QaSimEnvelopeKey` for `gprobe` → `SIM_KEY_WORLD_MISMATCH`
//   b  ScheduleDispatch  the CURRENT timer key, version and epoch of a paused milestone → `EARLY_FIRE_DISCARDED
//                        CLOCK_PAUSED`
//   c  CoreMock and NetworkMock  a payment and a collection by Function URL → 403 `CALLER_WORLD_DENIED`; a direct
//                        `lambda:InvokeFunction` with a fabricated `requestContext` → `AccessDenied`
//   d  WorldJanitor      `MEMORY_PURGE` and `WORLD_RESET` with an invented request id (and a high epoch in an
//                        extra field) → refused without a ticket (`MISSING`, or `INVALID` for the extra field)
//
// `refused` is true only when every path was refused and the hash did not move.
import { sha256Hex } from "../lib/crypto";
import { canonicalJson } from "../complaints/register";
import { SIMULATED_PHONE_NUMBER_ID, SIM_ATTRIBUTES, SIM_EVENT_SOURCE } from "../channels/whatsapp/config";
import type { SnsRecord, WhatsAppSnsEvent } from "../channels/whatsapp/payloads";
import { signSimulated, simulatedEnvelopeMessage } from "../channels/whatsapp/sim-envelope";
import { scheduleNameOf } from "../timers/schedule-name";
import { personaPhone } from "../routers/simulator";
import { inboundSummary } from "./actions-channels";
import type { ActionContext, QaPorts } from "./ports";

export const PROBE_WORLD = "gprobe";
/** `C01` of the `qa-min` template, the customer whose core rows are hashed and probed. */
const PROBE_CUSTOMER = "cus-0001";
const PROBE_LOAN = "L-0001";

export interface PathResult {
  readonly path: string;
  readonly refused: boolean;
  readonly answer: string;
}

/** What the probe hashes: complaints, timers, clock, tape and register heads, `C01`'s core rows. */
export async function gprobeHash(ports: Pick<QaPorts, "data">): Promise<string> {
  const { data } = ports;
  const clock = await data.runtime.getClock(PROBE_WORLD);
  const epoch = clock?.worldEpoch ?? 0;
  const [meta, complaints, timers, reg, rri, tape, conversation, ...core] = await Promise.all([
    data.worlds.getMeta(PROBE_WORLD, { consistent: true }),
    data.complaints.listOpen(PROBE_WORLD),
    data.timers.listDue(PROBE_WORLD, {}),
    data.chains.readHead(PROBE_WORLD, epoch, "REG"),
    data.chains.readHead(PROBE_WORLD, epoch, "RRI"),
    data.chains.readHead(PROBE_WORLD, epoch, "TAPE"),
    data.conversations.getMeta(PROBE_WORLD, PROBE_CUSTOMER),
    ...["META", "ACCOUNT", "WALLET"].map((sk) => data.worldItems.get("Core", PROBE_WORLD, { pk: `W#${PROBE_WORLD}#CUS#${PROBE_CUSTOMER}`, sk })),
  ]);
  return sha256Hex(
    canonicalJson({
      meta: meta === undefined ? null : { status: meta.status, epoch: meta.epoch, version: meta.version },
      clock: clock === undefined ? null : { mode: clock.mode, pausedSimNow: clock.pausedSimNow ?? null, version: clock.version },
      complaints: complaints.map((complaint) => ({ id: complaint.complaintId, status: complaint.status, version: complaint.version })),
      timers: timers.map((timer) => ({ kind: timer.kind, id: timer.timerId, status: timer.status, version: timer.version })),
      heads: [reg, rri, tape].map((head) => (head === undefined ? null : { value: head.value, hash: head.hash })),
      conversation: conversation === undefined ? null : { version: conversation.version },
      core: core.map((item) => (item === undefined ? null : { version: item.version ?? null, updatedAt: item.updatedAt ?? null })),
    }),
  );
}

/** (a) An envelope the QA key may never sign for a guest world: built by hand, as an attacker would. */
function forgedEnvelope(ports: Pick<QaPorts, "inbound" | "now">, key: string): WhatsAppSnsEvent {
  const at = ports.now();
  const wamid = `wamid.SIM.${sha256Hex(`fence#${key}`)}`;
  const message = simulatedEnvelopeMessage({ kid: "qa", worldId: PROBE_WORLD, from: personaPhone("C01"), wamid, content: { type: "text", text: "Hola" }, at });
  const ts = at.toISOString();
  const record: SnsRecord = {
    EventSource: SIM_EVENT_SOURCE,
    Sns: {
      Type: "Notification",
      MessageId: sha256Hex(`sns#${wamid}`).slice(0, 32),
      TopicArn: SIMULATED_PHONE_NUMBER_ID,
      Message: message,
      Timestamp: ts,
      MessageAttributes: {
        [SIM_ATTRIBUTES.kid]: { Type: "String", Value: "qa" },
        [SIM_ATTRIBUTES.worldId]: { Type: "String", Value: PROBE_WORLD },
        [SIM_ATTRIBUTES.ts]: { Type: "String", Value: ts },
        [SIM_ATTRIBUTES.signature]: { Type: "String", Value: signSimulated(ports.inbound.key(), "qa", PROBE_WORLD, ts, message) },
      },
    },
  };
  return { Records: [record] };
}

async function attempt(path: string, run: () => Promise<{ refused: boolean; answer: string }>): Promise<PathResult> {
  try {
    return { path, ...(await run()) };
  } catch (error) {
    // An exception is not a refusal the path decided: it is reported, and the probe fails.
    return { path, refused: false, answer: `ERROR:${error instanceof Error ? error.name : "unknown"}` };
  }
}

function statusOf(answer: unknown): string {
  const value = answer as { readonly status?: unknown; readonly reason?: unknown; readonly kind?: unknown; readonly result?: { readonly status?: unknown } } | undefined;
  if (value?.kind === "INVALID") return "INVALID";
  if (typeof value?.result?.status === "string") return value.result.status;
  return [value?.status, value?.reason].filter((part) => typeof part === "string").join(" ");
}

async function inboundPath(ctx: ActionContext): Promise<PathResult> {
  return attempt("a.InboundWhatsApp", async () => {
    const summary = inboundSummary(await ctx.ports.inbound.deliver(forgedEnvelope(ctx.ports, ctx.key)));
    return { refused: !summary.accepted && summary.reason === "SIM_KEY_WORLD_MISMATCH", answer: summary.reason ?? (summary.accepted ? "ACCEPTED" : "REFUSED") };
  });
}

async function schedulePath(ctx: ActionContext): Promise<PathResult> {
  return attempt("b.ScheduleDispatch", async () => {
    const { data } = ctx.ports;
    const [timer, clock] = await Promise.all([data.timers.next(PROBE_WORLD), data.runtime.getClock(PROBE_WORLD)]);
    if (timer === undefined || clock === undefined) return { refused: false, answer: "NO_PENDING_TIMER" };
    const timerKey = data.timers.timerKey({ worldId: PROBE_WORLD, kind: timer.kind, timerId: timer.timerId });
    const scheduleArn = ctx.ports.scheduleDispatch.scheduleArn(scheduleNameOf(PROBE_WORLD, clock.worldEpoch, timerKey));
    const answer = statusOf(await ctx.ports.scheduleDispatch.invoke({ worldId: PROBE_WORLD, timerKey, version: timer.version, epoch: clock.worldEpoch, dueAtSim: timer.dueAtSim, scheduleArn }));
    return { refused: answer === "EARLY_FIRE_DISCARDED CLOCK_PAUSED", answer };
  });
}

async function mockPaths(ctx: ActionContext): Promise<PathResult[]> {
  const { mocks } = ctx.ports;
  const viaUrl = (target: "CoreMock" | "NetworkMock", path: string, body: Record<string, unknown>) =>
    attempt(`c.${target}.url`, async () => {
      const answer = await mocks.urlPost(target, path, body);
      return { refused: answer.status === 403 && answer.reason === "CALLER_WORLD_DENIED", answer: `${answer.status} ${answer.reason ?? ""}`.trim() };
    });
  const direct = (target: "CoreMock" | "NetworkMock") =>
    attempt(`c.${target}.invoke`, async () => {
      const answer = await mocks.directInvoke(target, PROBE_WORLD);
      return { refused: answer === "AccessDeniedException", answer };
    });
  return Promise.all([
    viaUrl("CoreMock", `/v1/${PROBE_WORLD}/loans/${PROBE_LOAN}/payments`, { amount: 100, network: "WALLET", operationCode: "QA-PROBE-1" }),
    viaUrl("NetworkMock", `/v1/${PROBE_WORLD}/collections`, { network: "NORTE", customerRef: PROBE_CUSTOMER, loanRef: PROBE_LOAN, amount: 100 }),
    direct("CoreMock"),
    direct("NetworkMock"),
  ]);
}

/** A ULID nobody issued: no ticket of `gprobe` can carry it. */
function inventedRequestId(key: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...sha256Hex(`ticket#${key}`).slice(0, 26)].map((char) => alphabet[Number.parseInt(char, 16) % 32]).join("").replace(/^[^0-7]/, "0");
}

async function janitorPaths(ctx: ActionContext): Promise<PathResult[]> {
  const requestId = inventedRequestId(ctx.key);
  const paths: PathResult[] = [];
  for (const kind of ["MEMORY_PURGE", "WORLD_RESET"] as const) {
    for (const extra of [{}, { epoch: 999_999 }]) {
      paths.push(
        await attempt(`d.WorldJanitor.${kind}${"epoch" in extra ? ".extra" : ""}`, async () => {
          const answer = statusOf(await ctx.ports.janitorDirect({ kind, worldId: PROBE_WORLD, requestId, ...extra }));
          return { refused: answer === "MISSING" || answer === "INVALID", answer };
        }),
      );
    }
  }
  return paths;
}

/** The whole probe (see the header). */
export async function worldPathsProbe(ctx: ActionContext): Promise<{ readonly refused: boolean; readonly hashBefore: string; readonly hashAfter: string; readonly paths: readonly PathResult[] }> {
  const hashBefore = await gprobeHash(ctx.ports);
  const paths = [await inboundPath(ctx), await schedulePath(ctx), ...(await mockPaths(ctx)), ...(await janitorPaths(ctx))];
  const hashAfter = await gprobeHash(ctx.ports);
  const refused = paths.every((path) => path.refused) && hashBefore === hashAfter;
  ctx.log.info("qa_driver.fence_probe", { refused, paths: paths.length, unchanged: hashBefore === hashAfter });
  return { refused, hashBefore, hashAfter, paths };
}
