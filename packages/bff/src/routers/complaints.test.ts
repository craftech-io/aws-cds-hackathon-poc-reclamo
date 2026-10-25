import type { SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import type { StaffRole } from "@reclamo/shared";
import { AUTH_REASON } from "../auth/errors";
import { claimsOf, createTestDeps, staffRow } from "../auth/testing";
import { milestoneTimers, slaPlan } from "../complaints/sla";
import { transition } from "../complaints/state-machine";
import { TEST_HOLIDAYS, complaintsKit } from "../complaints/testing";
import { SIM_NOW, TEST_NOW, approval, auditEntry, complaint, conversation, email, evidence, message } from "../connector/testing";
import { sha256Hex } from "../lib/crypto";
import { createLogger } from "../lib/log";
import { appendTape } from "../outbound/tape";
import { SEED_RECEIPT_HASH_REFERENCE } from "../receipts/seed-hash";
import { createEnqueuer } from "../worker/enqueue";
import { complaintsRouter } from "./complaints";
import { type OperationsServices, bindOperations } from "./inbox";
import { createContextFactory, router } from "./trpc";

const PEOPLE = {
  operator: { staffId: "stf-operator-01", role: "OPERATOR" },
  compliance: { staffId: "stf-compliance-01", role: "COMPLIANCE" },
} as const satisfies Record<string, { staffId: string; role: StaffRole }>;

const SEED_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const SEED_KEY = "receipts/legible/c01-1.png";
const silent = createLogger({ sink: () => undefined });

async function caseWorld(overrides: Parameters<typeof complaint>[1] = {}) {
  const kit = complaintsKit({ worldId: "demo" });
  await kit.seedWorld();
  await kit.connector.runtime.putClock({ worldId: "demo", mode: "PAUSED", pausedSimNow: SIM_NOW, worldEpoch: 1 });
  for (const date of TEST_HOLIDAYS) await kit.store.write({ kind: "put", table: "Reference", item: { pk: "REF#HOLIDAY#AR", sk: date, date } });
  const plan = slaPlan(SIM_NOW, TEST_HOLIDAYS);
  await kit.connector.transact([
    kit.connector.conversations.createOp(conversation("demo")),
    kit.connector.complaints.createOp(complaint("demo", { deadlineSim: plan.deadlineSim, ...overrides })),
    ...milestoneTimers({ worldId: "demo", epoch: 1, complaintId: "cmp-0001", complaintNumber: "R-2026-000123", plan }).map((timer) => kit.connector.timers.putOp(timer)),
  ]);
  const sent: SendMessageCommandInput[] = [];
  const seedObjects = new Map<string, Uint8Array>([[SEED_KEY, SEED_BYTES]]);
  let next = 0;
  const services: OperationsServices = {
    data: kit.connector,
    chains: () => kit.deps,
    enqueuer: (log) => createEnqueuer({ data: kit.connector, send: async (input) => void sent.push(input), queueUrl: (queue) => `https://sqs.us-east-1.amazonaws.com/776805327629/${queue}`, now: () => TEST_NOW, log }),
    core: () => ({ call: async () => Promise.reject(new Error("the case view never reads the core")) }),
    images: () => ({ get: async (location) => (location.bucket === "Seed" ? seedObjects.get(location.key) : undefined) }),
    presignMedia: async (key, contentType) => `https://media.invalid/${key}?response-content-type=${encodeURIComponent(contentType)}&X-Amz-Expires=300`,
    newId: (prefix) => `${prefix}-${String(++next).padStart(4, "0")}`,
  };
  const { issuer, directory, deps } = createTestDeps();
  directory.setWorld("demo", "READY", 1);
  for (const [name, person] of Object.entries(PEOPLE)) directory.putStaff(staffRow("demo", person.staffId, person.role, `sub-${name}`));
  bindOperations(deps, services);
  const contextFor = createContextFactory(() => deps);
  const as = async (name: keyof typeof PEOPLE, signedInSecondsAgo = 0) => {
    const now = Math.floor(Date.now() / 1000);
    const token = issuer.idToken({ sub: `sub-${name}`, ...claimsOf({ worldId: "demo", ...PEOPLE[name] }, name), auth_time: now - signedInSecondsAgo, iat: now });
    return router({ complaints: complaintsRouter }).createCaller(await contextFor({ event: { headers: { authorization: `Bearer ${token}` } } }));
  };
  const events = () => sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as { type: string; customerId: string; payload: Record<string, unknown> });
  const knownSeedHash = () => kit.store.write({ kind: "put", table: "Reference", item: { pk: `REF#${SEED_RECEIPT_HASH_REFERENCE.type}#${SEED_RECEIPT_HASH_REFERENCE.scope}`, sk: sha256Hex(SEED_BYTES), sha256: sha256Hex(SEED_BYTES), seedKey: SEED_KEY } });
  return { kit, as, events, seedObjects, knownSeedHash };
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return { code: error.code, reason: error.cause && typeof error.cause === "object" ? Reflect.get(error.cause, "reason") : undefined };
  }
  throw new Error("expected a refusal");
}

const REF = { complaintId: "cmp-0001" } as const;
const IMAGE = { sha256: "a".repeat(64), contentType: "image/png", sizeBytes: 120_000, scan: "NO_THREATS_FOUND" } as const;

describe("the case in the console", () => {
  it("shows the complaint, its deadline, the conversation's control and its evidence without where the image lives", async () => {
    const { as, kit } = await caseWorld({ status: "INVESTIGATING" });
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-img-1", kind: "RECEIPT_IMAGE", details: { s3Key: "up/demo/x.png", ...IMAGE } }));
    await kit.connector.caseItems.createApproval(approval("demo"));
    const view = await (await as("compliance")).complaints.get(REF);
    expect(view.complaint).toMatchObject({ complaintNumber: "R-2026-000123", status: "INVESTIGATING", deadlineText: "jueves 22/10", businessDaysLeft: 10, blockedBy: "AGENT" });
    expect(view.conversation).toEqual({ control: "AGENT", controlledBy: null });
    expect(view.evidence).toEqual([expect.objectContaining({ evidenceId: "evd-img-1", kind: "RECEIPT_IMAGE", details: { sha256: IMAGE.sha256, contentType: "image/png", sizeBytes: 120_000, scan: "NO_THREATS_FOUND" } })]);
    expect(view.approvals[0]?.amount).toEqual({ amount: 300_000, text: "$ 300.000,00" });
    expect(await refusal(async () => (await as("operator")).complaints.get({ complaintId: "cmp-0404" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(async () => (await as("operator")).complaints.get({ ...REF, worldId: "g03" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_WORLD });
  });

  it("puts messages, emails with their proof, tape, actions, register, milestones, statuses and notes on one timeline, with what is pending", async () => {
    const { as, kit } = await caseWorld();
    await transition(kit.deps, { worldId: "demo", complaintId: "cmp-0001", to: "INVESTIGATING", cause: "IDENTIFIED", actor: "AGENT", atSim: "2026-10-07T10:12:00-03:00", holidays: TEST_HOLIDAYS });
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-in", atSim: "2026-10-07T10:09:00-03:00" }));
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-other", complaintId: "cmp-0777", atSim: "2026-10-07T10:11:00-03:00" }));
    await kit.connector.emails.put(email("demo", { complaintId: "cmp-0001", sentAtSim: "2026-10-07T10:14:00-03:00", deliveryProof: "DELIVERED", events: [{ type: "DELIVERY", atReal: TEST_NOW.toISOString() }] }));
    await appendTape({ chains: kit.deps }, { worldId: "demo", epoch: 1, atSim: "2026-10-07T10:10:30-03:00", decision: "ALLOWED", ruleIds: [], ruleSetVersion: "ch-2026.10.06", sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_ACK", customerId: "cus-0001", complaintId: "cmp-0001" }, silent);
    await kit.connector.audit.append(auditEntry("demo", { auditId: "aud-tool", action: "RECEIPT_READ", actor: "AGENT", atSim: "2026-10-07T10:13:00-03:00", outcome: "READ" }));
    await kit.connector.caseItems.putNote({ worldId: "demo", complaintId: "cmp-0001", noteId: "note-1", kind: "NOTE", atSim: "2026-10-07T10:15:00-03:00", author: "OPERATOR:stf-operator-01", text: "Revisar rendición" });
    await kit.connector.write(kit.connector.runtime.openPendingOp({ worldId: "demo", kind: "MAIL", pendingId: "mail-0001", openedAtReal: TEST_NOW.toISOString(), customerId: "cus-0001", complaintId: "cmp-0001" }));
    const { items, pending } = await (await as("operator")).complaints.timeline(REF);
    const kinds = items.map((item) => item.type);
    expect(new Set(kinds)).toEqual(new Set(["MESSAGE", "EMAIL", "TAPE", "ACTION", "MILESTONE", "REGISTER", "STATUS", "NOTE"]));
    expect(items.filter((item) => item.type === "MESSAGE").map((item) => item.messageId)).toEqual(["msg-in"]);
    expect(items.find((item) => item.type === "EMAIL")).toMatchObject({ deliveryProof: "DELIVERED", events: [{ type: "DELIVERY" }] });
    expect(items.find((item) => item.type === "TAPE")).toMatchObject({ decision: "ALLOWED", kind: "COMPLAINT_ACK" });
    expect(items.find((item) => item.type === "REGISTER")).toMatchObject({ eventType: "STATUS", status: "INVESTIGATING" });
    expect(items.filter((item) => item.type === "MILESTONE").map((item) => item.milestone)).toEqual(["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"]);
    const times = items.map((item) => Date.parse(item.atSim));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(pending).toEqual([{ kind: "MAIL", pendingId: "mail-0001", openedAtReal: TEST_NOW.toISOString(), reason: "WAITING_EMAIL_EVENT" }]);
  });

  it("leaves out the tape and the actions of an earlier epoch: a seeded case keeps its id across resets", async () => {
    const { as, kit } = await caseWorld();
    const tape = { atSim: "2026-10-07T10:10:30-03:00", decision: "ALLOWED", ruleIds: [], ruleSetVersion: "ch-2026.10.06", sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_ACK", customerId: "cus-0001", complaintId: "cmp-0001" } as const;
    await appendTape({ chains: kit.deps }, { worldId: "demo", epoch: 0, ...tape }, silent);
    await kit.connector.audit.append(auditEntry("demo", { epoch: 0, auditId: "aud-before-reset", action: "APPROVED", actor: "OPERATOR:stf-operator-01", atSim: "2026-10-07T10:13:00-03:00" }));
    await appendTape({ chains: kit.deps }, { worldId: "demo", epoch: 1, ...tape }, silent);
    await kit.connector.audit.append(auditEntry("demo", { auditId: "aud-now", action: "RECEIPT_READ", actor: "AGENT", atSim: "2026-10-07T10:13:00-03:00" }));
    const { items } = await (await as("operator")).complaints.timeline(REF);
    expect(items.filter((item) => item.type === "TAPE")).toHaveLength(1);
    expect(items.filter((item) => item.type === "ACTION").map((item) => item.action)).toEqual(["RECEIPT_READ"]);
  });
});

describe("evidence image for fetch() → blob:", () => {
  it("signs a 5-minute GET of a scanned Media image with its content type", async () => {
    const { as, kit } = await caseWorld();
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-img-1", kind: "RECEIPT_IMAGE", details: { s3Key: "up/demo/x.png", ...IMAGE } }));
    const file = await (await as("operator")).complaints.evidenceUrl({ ...REF, evidenceId: "evd-img-1" });
    expect(file).toEqual({ evidenceId: "evd-img-1", kind: "URL", contentType: "image/png", sha256: IMAGE.sha256, expiresInSeconds: 300, url: expect.stringContaining("up/demo/x.png?response-content-type=image%2Fpng") });
  });

  it("returns a seed receipt inline only when its hash is one the seed rendered and the object is unchanged", async () => {
    const { as, kit, knownSeedHash, seedObjects } = await caseWorld();
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-seed", kind: "RECEIPT_IMAGE", details: { seedKey: SEED_KEY, sha256: sha256Hex(SEED_BYTES), contentType: "image/png" } }));
    const operator = await as("operator");
    expect(await refusal(() => operator.complaints.evidenceUrl({ ...REF, evidenceId: "evd-seed" }))).toEqual({ code: "PRECONDITION_FAILED", reason: "UNKNOWN_SEED_HASH" });
    await knownSeedHash();
    expect(await operator.complaints.evidenceUrl({ ...REF, evidenceId: "evd-seed" })).toEqual({ evidenceId: "evd-seed", kind: "INLINE", contentType: "image/png", sha256: sha256Hex(SEED_BYTES), dataBase64: Buffer.from(SEED_BYTES).toString("base64") });
    seedObjects.set(SEED_KEY, new Uint8Array([1, 2, 3]));
    expect(await refusal(() => operator.complaints.evidenceUrl({ ...REF, evidenceId: "evd-seed" }))).toEqual({ code: "PRECONDITION_FAILED", reason: "IMAGE_CHANGED" });
  });

  it("has no file for a reading, nor for evidence of another complaint", async () => {
    const { as, kit } = await caseWorld();
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-rdg" }));
    const operator = await as("operator");
    expect(await refusal(() => operator.complaints.evidenceUrl({ ...REF, evidenceId: "evd-rdg" }))).toEqual({ code: "PRECONDITION_FAILED", reason: "NOT_AN_IMAGE" });
    expect(await refusal(() => operator.complaints.evidenceUrl({ ...REF, evidenceId: "evd-elsewhere" }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("written answer of an operator in a human case [FL-089]", () => {
  const ANSWER = { ...REF, outcome: "NOT_IN_FAVOUR" as const, draftBody: "El cargo corresponde al pedido de reposición del 02/09.", requestedAttachments: ["STATEMENT" as const] };

  it("[FL-089] checks the preconditions and enqueues OPERATOR_ANSWER; the PDF and the email are the worker's", async () => {
    const { as, events, kit } = await caseWorld({ status: "HUMAN_REVIEW", emailAnswerConsent: { status: "ACCEPTED", atSim: SIM_NOW } });
    const queued = await (await as("operator")).complaints.answer(ANSWER);
    expect(queued).toMatchObject({ status: "QUEUED", messageId: expect.stringMatching(/^ans-/) });
    expect(events()).toEqual([
      expect.objectContaining({
        type: "OPERATOR_ANSWER",
        customerId: "cus-0001",
        payload: { staffId: "stf-operator-01", messageId: queued.messageId, complaintId: "cmp-0001", outcome: "NOT_IN_FAVOUR", draftBody: ANSWER.draftBody, requestedAttachments: ["STATEMENT"] },
      }),
    ]);
    // Nothing is claimed nor written by the console: the worker claims `answer.inFlight` with `FINAL_ANSWER`.
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.answer).toBeUndefined();
  });

  it("[FL-089] refuses without the email accepted, before the case is resolved or in a person's hands, or once answered", async () => {
    const pending = await caseWorld({ status: "HUMAN_REVIEW" });
    expect(await refusal(async () => (await pending.as("operator")).complaints.answer(ANSWER))).toEqual({ code: "PRECONDITION_FAILED", reason: "EMAIL_NOT_ACCEPTED" });
    const working = await caseWorld({ status: "INVESTIGATING", emailAnswerConsent: { status: "ACCEPTED" } });
    expect(await refusal(async () => (await working.as("operator")).complaints.answer(ANSWER))).toEqual({ code: "PRECONDITION_FAILED", reason: "NOT_RESOLVED" });
    const answered = await caseWorld({ status: "RESOLVED", emailAnswerConsent: { status: "ACCEPTED" }, answer: { messageId: "ans-1", deliveryProof: "SENT" } });
    expect(await refusal(async () => (await answered.as("operator")).complaints.answer(ANSWER))).toEqual({ code: "CONFLICT", reason: "ANSWER_SENT" });
    for (const world of [pending, working, answered]) expect(world.events()).toEqual([]);
  });

  it("[FL-089] asks for a sign-in of at most 15 minutes, and compliance never answers", async () => {
    const { as, events } = await caseWorld({ status: "HUMAN_REVIEW", emailAnswerConsent: { status: "ACCEPTED" } });
    expect(await refusal(async () => (await as("operator", 20 * 60)).complaints.answer(ANSWER))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.LOGIN_NOT_RECENT });
    expect(await refusal(async () => (await as("compliance")).complaints.answer(ANSWER))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.READ_ONLY_ROLE });
    expect(events()).toEqual([]);
  });
});

describe("escalation and notes", () => {
  it("escalates to a person through the state machine, with its register entry and audit, once", async () => {
    const { as, kit } = await caseWorld({ status: "AWAITING_CUSTOMER" });
    const operator = await as("operator");
    expect(await operator.complaints.escalate({ ...REF, reason: "RECEIPT_DOUBT", summary: "Comprobante dudoso" })).toEqual({ status: "HUMAN_REVIEW", already: false });
    const moved = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(moved).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RECEIPT_DOUBT", summary: "Comprobante dudoso" } });
    expect(moved?.statusHistory.at(-1)).toMatchObject({ cause: "ESCALATED_RECEIPT_DOUBT", actor: "OPERATOR:stf-operator-01" });
    expect((await kit.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.status)).toEqual(["HUMAN_REVIEW"]);
    expect(await kit.connector.audit.listByAction("demo", "ESCALATED")).toHaveLength(1);
    expect(await operator.complaints.escalate(REF)).toEqual({ status: "HUMAN_REVIEW", already: true });
  });

  it("does not escalate a closed complaint", async () => {
    const { as } = await caseWorld({ status: "CLOSED" });
    expect(await refusal(async () => (await as("operator")).complaints.escalate(REF))).toEqual({ code: "PRECONDITION_FAILED", reason: "CANNOT_ESCALATE" });
  });

  it("keeps an internal note masked, signed by its author", async () => {
    const { as, kit } = await caseWorld();
    const { noteId } = await (await as("operator")).complaints.note({ ...REF, text: "Llamó desde el 11 5555-1234, DNI 30123456" });
    const [note] = await kit.connector.caseItems.listNotes("demo", "cmp-0001");
    expect(note).toMatchObject({ noteId, kind: "NOTE", author: "OPERATOR:stf-operator-01" });
    expect(note?.text).not.toContain("30123456");
    expect(note?.text).not.toContain("5555-1234");
  });
});
