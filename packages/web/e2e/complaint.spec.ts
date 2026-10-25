// FL-017, FL-067, FL-069, FL-084, FL-085, FL-089 · /app/complaints/:id on the console alone (BFF and
// Cognito scripted, no AWS): the evidence of the main story with the receipt image shown from a
// `blob:` URL and its reading (model and fallback), "Avanzar al próximo hito de este reclamo", human
// mode (take, write through the gate, the collection text blocked in red with the lexicon's
// categories, templates only outside the 24-hour window, hand back) and the written answer with the
// recent-login prompt (a sign-in of 20 minutes ago → password → the answer goes on; cancel → 403).
import { type Page, expect, test } from "@playwright/test";
import { TEMPLATE_STATUS_PHRASES } from "../../bff/src/copy/template-status.ts";
import type { RouterOutputs } from "../src/lib/trpc-router.ts";
import { mediaCopy, scanText } from "../src/copy/media.ts";
import { complaintCopy } from "../src/views/complaint/copy.ts";
import { customerCopy } from "../src/views/customer/copy.ts";
import { loginCopy } from "../src/views/login/copy.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, refusal, routeApi } from "./support/api-route";
import { PASSWORD_VERIFIER, routeCognito, tokensAnswer } from "./support/cognito-route";
import { type FakeClaims, plantSession } from "./support/session";

type CaseView = RouterOutputs["complaints"]["get"];
type Timeline = RouterOutputs["complaints"]["timeline"];
type CustomerFile = RouterOutputs["customers"]["get"];
type TapeList = RouterOutputs["tape"]["list"];
type Tape = TapeList["entries"];

const PASSWORD = "Fixture-Password-1!";
const OPERATOR: FakeClaims = { username: "operator-01", role: "OPERATOR", worldId: "demo", signedInAgo: 60 };
const STALE_OPERATOR: FakeClaims = { ...OPERATOR, signedInAgo: 20 * 60 };
const CASE_URL = "/app/complaints/cmp-c01";

interface CaseState {
  /** `evidenceUrl` answers a presigned GET of `Media` (an uploaded image) instead of the seed's bytes. */
  mediaUrl?: string;
  control: "AGENT" | "OPERATOR";
  windowOpen: boolean;
  status: "AWAITING_SETTLEMENT" | "HUMAN_REVIEW";
  /** `complaints.answer` refuses with LOGIN_NOT_RECENT while true. */
  staleAnswer: boolean;
  /** What the tape holds for the message the person sent. */
  tape: Tape;
  blockedAttempt?: string;
  readonly bodies: Record<string, unknown[]>;
  calls: Awaited<ReturnType<typeof routeApi>>;
}

// ---- Fixtures: the main story of the demo world (C01, a payment at the collection network) -------

const SIM_NOW = "2026-10-07T13:20:00.000Z";
const STAFF_SENDER = "OPERATOR:stf-operator-01";
/** A 1×1 PNG: real bytes, so the browser decodes the image it shows from its blob: URL. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Fixture = Pick<CaseState, "control" | "windowOpen" | "status" | "blockedAttempt">;

function caseFile(state: Fixture): CaseView {
  const evidence = (evidenceId: string, kind: CaseView["evidence"][number]["kind"], details: Record<string, unknown>) => ({ evidenceId, kind, refId: null, atSim: SIM_NOW, actor: "AGENT", details });
  return {
    complaint: {
      complaintId: "cmp-c01", complaintNumber: "R-2026-000123", customerId: "cus-c01", kind: "RECLAMO", type: "PAYMENT_NOT_REFLECTED", status: state.status, outcome: null,
      priority: "NORMAL", origin: "LIVE", control: state.control, channel: "WHATSAPP", summary: "Pagó la cuota 4 en la Red de cobro Norte y no se refleja.", subject: null,
      filedAtSim: "2026-10-07T13:12:00.000Z", deadlineSim: "2026-10-23T02:59:59.000Z", deadlineText: "jueves 22/10", businessDaysLeft: 10, slaState: "ON_TIME",
      blockedBy: state.status === "HUMAN_REVIEW" ? "PERSON" : "NETWORK", emailAnswerConsent: { status: "ACCEPTED", atSim: "2026-10-07T13:13:00.000Z", textVersion: "email-answer-v1" }, answer: null, handoff: null, version: 4,
    },
    conversation: { control: state.control, controlledBy: state.control === "OPERATOR" ? "stf-operator-01" : null },
    evidence: [
      evidence("evd-c01-img", "RECEIPT_IMAGE", { sha256: "a".repeat(64), contentType: "image/png", sizeBytes: 68, scan: "SEED_SKIPPED", source: "SEED_COPY" }),
      evidence("evd-c01-read", "RECEIPT_READING", {
        result: "READ", source: "BOTH_AGREE", suspiciousText: false, imageEvidenceId: "evd-c01-img", bedrock: { legibility: "CLEAR", isReceipt: true }, fallback: { present: true, agrees: true },
        fields: { network: "NORTE", operationCode: "NTE-20261006-184012-7", amount: 11864000, paidAtLocal: "2026-10-06T18:40" },
      }),
      evidence("evd-c01-match", "SETTLEMENT_MATCH", { result: "PENDING_BATCH", source: "SETTLEMENT", readingId: "rdg-c01", network: "NORTE", operationCode: "NTE-20261006-184012-7", pending: { network: "NORTE", businessDate: "2026-10-07", publishAtSim: "2026-10-08T11:30:00.000Z" } }),
    ],
    actions: [],
    approvals: [],
    executions: [],
    notes: [{ worldId: "demo", complaintId: "cmp-c01", noteId: "note-agent-1", kind: "NOTE", atSim: SIM_NOW, author: "AGENT", text: "Registramos tu pago de $ 118.640,00 en la cuota 4." }],
    simNow: SIM_NOW,
  } as CaseView;
}

function timelineOf(state: Fixture): Timeline {
  const items: Timeline["items"] = [
    { type: "MESSAGE", atSim: "2026-10-07T13:11:00.000Z", messageId: "msg-in-1", direction: "IN", channel: "WHATSAPP", kind: null, sender: null, body: "Hola, pagué la cuota 4 ayer en la Red de cobro Norte y no me figura.", media: null, templateName: null, status: "RECEIVED", disclosure: false, tapeRef: null },
    { type: "MESSAGE", atSim: "2026-10-07T13:11:00.000Z", messageId: "msg-in-2", direction: "IN", channel: "WHATSAPP", kind: null, sender: null, body: "", media: { scan: "SEED_SKIPPED" }, templateName: null, status: "RECEIVED", disclosure: false, tapeRef: null },
    { type: "REGISTER", atSim: "2026-10-07T13:12:00.000Z", seq: 123, eventType: "FILED", status: "REGISTERED", reason: null, hash: "b".repeat(64) },
    { type: "STATUS", atSim: "2026-10-07T13:14:00.000Z", from: "INVESTIGATING", to: "AWAITING_SETTLEMENT", cause: "PENDING_BATCH", actor: "AGENT" },
    { type: "MILESTONE", atSim: "2026-10-15T13:00:00.000Z", timerId: "tm-c01-rem", kind: "SLA", milestone: "OPERATOR_REMINDER", status: "SCHEDULED", firedAtSim: null, firedBy: null },
  ];
  if (state.blockedAttempt !== undefined) {
    items.push({ type: "MESSAGE", atSim: SIM_NOW, messageId: "opm-e2e-1", direction: "OUT", channel: "WHATSAPP", kind: "REPLY", sender: STAFF_SENDER, body: state.blockedAttempt, media: null, templateName: null, status: "BLOCKED", disclosure: false, tapeRef: "tp-blk" });
  }
  return { complaintId: "cmp-c01", complaintNumber: "R-2026-000123", items, pending: [] } as Timeline;
}

function customerFile(state: Fixture): CustomerFile {
  return {
    customer: {
      customerId: "cus-c01", firstName: "Valeria", lastName: "Quiroga", document: { type: "DNI", numberMasked: "••••4417" }, phoneMasked: "+54 9 ••• •••-0101", emailMasked: "v•••@…",
      whatsapp: { optedIn: true, optedOut: false }, account: { status: "ACTIVE" }, wallet: { balance: 0, cvuMasked: "•••• 0101", outgoingFrozen: false, balanceMoney: { amount: 0, text: "$ 0,00" } }, loans: [],
    },
    operations: [], operationsTruncated: false, complaints: [],
    conversation: { control: state.control, controlledBy: state.control === "OPERATOR" ? "stf-operator-01" : null, windowOpenUntilSim: state.windowOpen ? "2026-10-08T13:11:00.000Z" : "2026-10-06T10:00:00.000Z" },
    challenge: { locked: false, failures: 0, attemptsLeft: 2 }, composeKinds: ["OPERATOR_MESSAGE", "COMPLAINT_UPDATE"], simNow: SIM_NOW,
  } as CustomerFile;
}

function tapeEntry(overrides: Partial<Tape[number]> & Pick<Tape[number], "decision" | "seq">): Tape[number] {
  return {
    worldId: "demo", epoch: 1, prevHash: "0".repeat(64), hash: "1".repeat(64), tapeId: `tp-${overrides.seq}`, atSim: SIM_NOW, ruleIds: [], evaluated: [],
    ruleSetVersion: "ch-2026.10.06", sender: STAFF_SENDER, channel: "WHATSAPP", kind: "OPERATOR_MESSAGE", complaintId: "cmp-c01", ...overrides,
  } as Tape[number];
}

function tapeList(entries: Tape): TapeList {
  return { epoch: 1, total: entries.length, matching: entries.length, byDecision: {}, violations: 0, entries: [...entries].sort((a, b) => b.seq - a.seq), cursor: null };
}

// ---- The scripted BFF ---------------------------------------------------------------------------

function answerFor(state: CaseState, path: string): ApiAnswer {
  switch (path) {
    case "complaints.get":
      return { data: caseFile(state) };
    case "complaints.timeline":
      return { data: timelineOf(state) };
    case "customers.get":
      return { data: customerFile(state) };
    case "complaints.evidenceUrl":
      if (state.mediaUrl !== undefined) return { data: { kind: "URL", evidenceId: "evd-c01-img", contentType: "image/png", sha256: "a".repeat(64), url: state.mediaUrl, expiresInSeconds: 300 } };
      return { data: { kind: "INLINE", evidenceId: "evd-c01-img", contentType: "image/png", sha256: "a".repeat(64), dataBase64: PNG_1X1 } };
    case "clock.advanceToNext":
      return { data: { worldId: "demo", mode: "PAUSED", fromSim: "2026-10-07T13:20:00.000Z", simNow: "2026-10-08T11:30:00.000Z", worldEpoch: 1, fired: [], forced: false } };
    case "conversation.take":
      state.control = "OPERATOR";
      return { data: { control: "OPERATOR", already: false } };
    case "conversation.release":
      state.control = "AGENT";
      return { data: { control: "AGENT", eventId: "evt-rel-cus-c01-v3", messageIds: ["opm-e2e-1"] } };
    case "conversation.send":
      return { data: { status: "QUEUED", messageId: "opm-e2e-1", eventId: "evt-opm-e2e-1" } };
    case "tape.list":
      return { data: tapeList(state.tape) };
    case "complaints.answer":
      return state.staleAnswer ? refusal("FORBIDDEN", 403, "LOGIN_NOT_RECENT") : { data: { status: "QUEUED", messageId: "ans-e2e-1", eventId: "evt-ans-e2e-1" } };
    case "clock.get":
      return { data: { mode: "PAUSED", simNow: "2026-10-07T13:20:00.000Z" } };
    default:
      return NOT_IMPLEMENTED;
  }
}

async function scriptCase(page: Page, initial: Partial<CaseState> = {}): Promise<CaseState> {
  const state: CaseState = { control: "AGENT", windowOpen: true, status: "AWAITING_SETTLEMENT", staleAnswer: false, tape: [], bodies: {}, calls: [], ...initial };
  state.calls = await routeApi(page, (path) => answerFor(state, path));
  for (const path of ["clock.advanceToNext", "conversation.send", "complaints.answer"]) {
    await page.route(`**/api/${path}**`, async (route) => {
      (state.bodies[path] ??= []).push(route.request().postDataJSON());
      await route.fallback();
    });
  }
  return state;
}

function count(state: CaseState, path: string): number {
  return state.calls.filter((call) => call.path === path).length;
}

test.describe("evidence and the case's clock [FL-017]", () => {
  test("[FL-017] the receipt image is shown from a blob: URL, next to the fields read by the model and the fallback", async ({ page }) => {
    await scriptCase(page);
    await plantSession(page, OPERATOR);
    await page.goto(CASE_URL);
    await expect(page.getByRole("heading", { name: "R-2026-000123" })).toBeVisible();
    const evidence = page.getByRole("region", { name: complaintCopy.sections.evidence });
    const image = evidence.getByRole("img", { name: complaintCopy.evidence.imageAlt });
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // The reading sits with its image, in the image's own card.
    const reading = evidence.getByRole("article", { name: complaintCopy.evidence.kind.RECEIPT_IMAGE }).getByRole("region", { name: complaintCopy.evidence.kind.RECEIPT_READING });
    await expect(reading).toContainText("NTE-20261006-184012-7");
    await expect(reading).toContainText("$ 118.640,00");
    await expect(reading).toContainText(complaintCopy.evidence.source["BOTH_AGREE"] ?? "");
    await expect(reading).toContainText(complaintCopy.evidence.fallbackPresent(true));
    const settlement = evidence.getByRole("article", { name: complaintCopy.evidence.kind.SETTLEMENT_MATCH });
    await expect(settlement).toContainText(complaintCopy.evidence.settlement.pending("jue 08/10 08:30"));
    await expect(settlement).toContainText("Red de cobro Norte");
    await expect(settlement).not.toContainText(/PENDING_BATCH|rdg-c01|readingId/);
  });

  test("[FL-017] an uploaded image is fetched from its 5-minute GET and still shown from a blob: URL", async ({ page }) => {
    const mediaUrl = "https://reclamo-poc-media-000000000000.s3.us-east-1.amazonaws.com/w/demo/receipt.png?X-Amz-Expires=300";
    await scriptCase(page, { mediaUrl });
    const fetched: string[] = [];
    await page.route("https://reclamo-poc-media-000000000000.s3.us-east-1.amazonaws.com/**", async (route) => {
      fetched.push(route.request().url());
      await route.fulfill({ status: 200, headers: { "content-type": "image/png", "access-control-allow-origin": "*" }, body: Buffer.from(PNG_1X1, "base64") });
    });
    await plantSession(page, OPERATOR);
    await page.goto(CASE_URL);
    const image = page.getByRole("img", { name: complaintCopy.evidence.imageAlt });
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(fetched).toEqual([mediaUrl]);
  });

  test("[FL-017] the timeline shows the wait for the settlement, and 'Avanzar al próximo hito' moves this world's clock", async ({ page }) => {
    const state = await scriptCase(page);
    await plantSession(page, OPERATOR);
    await page.goto(CASE_URL);
    const timeline = page.getByRole("region", { name: complaintCopy.sections.timeline });
    await expect(timeline).toContainText("En investigación → Espera la rendición de la red");
    await expect(timeline).toContainText("Recordatorio al operador (día hábil 5)");
    await expect(timeline).toContainText("Hola, pagué la cuota 4 ayer en la Red de cobro Norte y no me figura.");
    await expect(timeline).toContainText(`${mediaCopy.receipt} · ${scanText("SEED_SKIPPED")}`);
    await expect(timeline).not.toContainText("SEED_SKIPPED");
    const before = count(state, "complaints.get");
    await page.getByRole("button", { name: complaintCopy.advance }).click();
    await expect(page.getByText(complaintCopy.advanced("jue 08/10 08:30"))).toBeVisible();
    expect(state.bodies["clock.advanceToNext"]?.[0]).toMatchObject({ "0": { complaintId: "cmp-c01" } });
    await expect.poll(() => count(state, "complaints.get")).toBeGreaterThan(before);
  });
});

test.describe("human mode [FL-084] [FL-085] [FL-067] [FL-069]", () => {
  test("[FL-084] [FL-085] take the conversation, write through the gate (ALLOWED and its dispatch) and hand it back", async ({ page }) => {
    const state = await scriptCase(page);
    await plantSession(page, OPERATOR);
    await page.goto(CASE_URL);
    const panel = page.getByRole("region", { name: complaintCopy.sections.conversation });
    await expect(panel).toContainText(complaintCopy.conversation.byAgent);
    await panel.getByRole("button", { name: complaintCopy.conversation.take }).click();
    await expect(panel).toContainText(complaintCopy.conversation.byMe);

    state.tape = [
      tapeEntry({ decision: "DISPATCH", messageId: "opm-e2e-1", seq: 31, result: "SENT" }),
      tapeEntry({ decision: "ALLOWED", messageId: "opm-e2e-1", seq: 30, ruleIds: ["CH-CONTROL", "CH-WA-24H"] }),
    ];
    const text = panel.getByRole("textbox", { name: complaintCopy.conversation.text });
    await expect(text).toBeEnabled();
    await text.fill("Hola Valeria, soy Lucía del equipo de atención. Ya estoy mirando tu pago.");
    await panel.getByRole("button", { name: complaintCopy.conversation.send }).first().click();
    const trail = panel.getByRole("region", { name: customerCopy.trail.title });
    await expect(trail.getByText("PERMITIDO · ALLOWED")).toBeVisible();
    await expect(trail.getByText(/ENVÍO · DISPATCH · enviado/)).toBeVisible();
    expect(state.bodies["conversation.send"]?.[0]).toMatchObject({ "0": { customerId: "cus-c01", complaintId: "cmp-c01", text: "Hola Valeria, soy Lucía del equipo de atención. Ya estoy mirando tu pago." } });

    await panel.getByRole("button", { name: complaintCopy.conversation.release }).click();
    await expect(panel.getByText(complaintCopy.conversation.released)).toBeVisible();
    await expect(panel).toContainText(complaintCopy.conversation.byAgent);
  });

  test("[FL-067] a person's collection text is blocked in red, with the lexicon's categories and the permitted paths", async ({ page }) => {
    const attempt = "Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos";
    const state = await scriptCase(page, { control: "OPERATOR" });
    await plantSession(page, OPERATOR);
    await page.goto(CASE_URL);
    const panel = page.getByRole("region", { name: complaintCopy.sections.conversation });
    state.tape = [tapeEntry({ decision: "BLOCKED", messageId: "opm-e2e-1", seq: 40, tapeId: "tp-blk", ruleIds: ["CH-WA-NO-COLLECTION"], kind: "REPLY" })];
    state.blockedAttempt = attempt;
    await panel.getByRole("textbox", { name: complaintCopy.conversation.text }).fill(attempt);
    await panel.getByRole("button", { name: complaintCopy.conversation.send }).first().click();

    const banner = panel.getByRole("alert").filter({ hasText: "BLOQUEADO · BLOCKED · CH-WA-NO-COLLECTION" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("EN: BLOCKED · CH-WA-NO-COLLECTION · WhatsApp Commerce Policy (debt collection)");
    await expect(banner.getByRole("button", { name: /Derivar a la cola humana/ })).toBeVisible();

    const timeline = page.getByRole("region", { name: complaintCopy.sections.timeline });
    await expect(timeline).toContainText(complaintCopy.timeline.blockedAttempt);
    await expect(timeline).toContainText(complaintCopy.timeline.lexicon);
    await expect(timeline).toContainText("Exhortación de pago");
    await expect(timeline).toContainText("Amenaza de consecuencias");
  });

  test("[FL-069] outside the 24-hour window the free text is disabled and only an approved template goes out", async ({ page }) => {
    const state = await scriptCase(page, { control: "OPERATOR", windowOpen: false });
    await plantSession(page, OPERATOR);
    await page.goto(CASE_URL);
    const panel = page.getByRole("region", { name: complaintCopy.sections.conversation });
    await expect(panel.getByText(complaintCopy.conversation.windowClosed)).toBeVisible();
    await expect(panel.getByRole("textbox", { name: complaintCopy.conversation.text })).toBeDisabled();
    await expect(panel.getByLabel(complaintCopy.conversation.template)).toHaveValue("reclamo_novedad");
    await panel.getByLabel(complaintCopy.conversation.statusPhrase).selectOption("SETTLEMENT_PUBLISHED");
    await expect(panel.getByText(`Hola Valeria, hay una novedad en tu reclamo R-2026-000123: ${TEMPLATE_STATUS_PHRASES.SETTLEMENT_PUBLISHED}. Podés responder por acá.`)).toBeVisible();
    state.tape = [tapeEntry({ decision: "ALLOWED", messageId: "opm-e2e-1", seq: 50, ruleIds: ["CH-WA-24H"], kind: "COMPLAINT_UPDATE" }), tapeEntry({ decision: "DISPATCH", messageId: "opm-e2e-1", seq: 51, result: "SENT", kind: "COMPLAINT_UPDATE" })];
    await panel.getByRole("button", { name: complaintCopy.conversation.send }).last().click();
    await expect(panel.getByText("PERMITIDO · ALLOWED")).toBeVisible();
    expect(state.bodies["conversation.send"]?.[0]).toMatchObject({ "0": { template: { name: "reclamo_novedad", params: ["Valeria", "R-2026-000123", "SETTLEMENT_PUBLISHED"] } } });
  });
});

test.describe("written answer [FL-089]", () => {
  test("[FL-089] a sign-in of 20 minutes ago: the bilingual password prompt opens, the password confirms and the answer is queued", async ({ page }) => {
    const state = await scriptCase(page, { status: "HUMAN_REVIEW", staleAnswer: true });
    const cognito = await routeCognito(page, {
      InitiateAuth: PASSWORD_VERIFIER,
      RespondToAuthChallenge: () => {
        state.staleAnswer = false;
        return tokensAnswer({ ...OPERATOR, signedInAgo: 0 });
      },
    });
    await plantSession(page, STALE_OPERATOR);
    await page.goto(CASE_URL);
    const answer = page.getByRole("region", { name: complaintCopy.sections.answer });
    await expect(answer.getByRole("textbox", { name: new RegExp(complaintCopy.answer.draft) })).toHaveValue(/Registramos tu pago/);
    await answer.getByLabel("Estado de cuenta").check();
    await answer.getByRole("button", { name: complaintCopy.answer.open }).click();

    const dialog = page.getByRole("dialog", { name: loginCopy.stepUp.title });
    await expect(dialog).toContainText("Approving money requires a recent sign-in");
    await dialog.getByLabel(loginCopy.credentials.password, { exact: true }).fill(PASSWORD);
    await dialog.getByRole("button", { name: loginCopy.credentials.submit }).click();
    await expect(answer.getByText(complaintCopy.answer.queued)).toBeVisible();
    expect(count(state, "complaints.answer")).toBe(2);
    expect(state.bodies["complaints.answer"]?.at(-1)).toMatchObject({ "0": { complaintId: "cmp-c01", outcome: "IN_FAVOUR", requestedAttachments: ["STATEMENT"] } });
    for (const call of cognito) expect(call.body).not.toContain(PASSWORD);
  });

  test("[FL-089] cancelling the password prompt leaves the 403 and answers nothing", async ({ page }) => {
    const state = await scriptCase(page, { status: "HUMAN_REVIEW", staleAnswer: true });
    await routeCognito(page, {});
    await plantSession(page, STALE_OPERATOR);
    await page.goto(CASE_URL);
    const answer = page.getByRole("region", { name: complaintCopy.sections.answer });
    await answer.getByRole("button", { name: complaintCopy.answer.open }).click();
    const dialog = page.getByRole("dialog", { name: loginCopy.stepUp.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: loginCopy.close }).click();
    await expect(dialog).toBeHidden();
    await expect(answer.getByRole("alert").filter({ hasText: "15 minutos" })).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(count(state, "complaints.answer")).toBe(1);
    await expect(answer.getByText(complaintCopy.answer.queued)).toHaveCount(0);
  });

  test("[FL-089] compliance reads the case without any action", async ({ page }) => {
    await scriptCase(page, { status: "HUMAN_REVIEW" });
    await plantSession(page, { username: "compliance-01", role: "COMPLIANCE", worldId: "demo" });
    await page.goto(CASE_URL);
    await expect(page.getByRole("region", { name: complaintCopy.sections.timeline })).toBeVisible();
    await expect(page.getByRole("button", { name: complaintCopy.advance })).toHaveCount(0);
    await expect(page.getByRole("region", { name: complaintCopy.sections.conversation })).toHaveCount(0);
    await expect(page.getByRole("region", { name: complaintCopy.sections.answer })).toHaveCount(0);
  });
});
