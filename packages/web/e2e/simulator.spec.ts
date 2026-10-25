// FL-101 · the phone simulator (`/app/simulator`) on the console alone: `simulator.*` is answered from the
// page with the shapes of the BFF (support/api-route.ts) and the presigned POST of a test image by a
// scripted endpoint, so the 41 personas, the script, the buttons, the gloss, "El agente está
// escribiendo…" and the upload checks run without AWS. Nothing leaves the machine.
import { type Page, type Request, expect, test } from "@playwright/test";
import { AUTOMATED_DISCLOSURE } from "@reclamo/bff/copy/es-AR";
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import { copy } from "../src/copy/console.ts";
import { simulatorCopy } from "../src/views/simulator/copy.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, refusal, routeApi } from "./support/api-route";
import { plantSession } from "./support/session";

const GUEST = { username: "guest-03", role: "GUEST", worldId: "g03" } as const;
const AT = "2026-10-07T10:10:00-03:00";
const UPLOAD_URL = "http://127.0.0.1:4273/__upload-target/";
const VALERIA = PERSONA_SCRIPTS[0];
if (VALERIA === undefined) throw new Error("no personas");

const PERSONAS = {
  personas: PERSONA_SCRIPTS.map((script) => ({
    persona: script.id,
    customerId: `cus-${script.id.slice(1).padStart(4, "0")}`,
    name: script.name,
    phoneMasked: `+54*******${script.id.slice(1).padStart(4, "0")}`,
    scenario: script.scenario,
    scenarioEn: script.scenarioEn,
    script: script.messages.map((message) => ({ text: message.text, en: message.en, receipt: message.attachment?.kind === "RECEIPT_IMAGE" })),
    hasReceipt: script.messages.some((message) => message.attachment?.kind === "RECEIPT_IMAGE"),
  })),
  unlinked: { persona: "UNLINKED", phoneMasked: "+54*******3000", text: "Hola, quiero hacer un reclamo por un pago", en: "Hi, I want to file a complaint about a payment" },
};

const ACK = {
  messageId: "msg-l000002",
  direction: "OUT",
  body: `${AUTOMATED_DISCLOSURE}\nRegistré tu reclamo R-2026-000123 (pago no reflejado). La respuesta escrita te llega a más tardar el jueves 22/10.`,
  templateName: null,
  buttons: [
    { index: 0, action: "ACCEPT_EMAIL", title: "Sí, a ese email" },
    { index: 1, action: "TALK_TO_HUMAN", title: "Hablar con alguien" },
  ],
  image: null,
  status: "DELIVERED",
  atSim: AT,
};
const INBOUND = { messageId: "wa-in-1", direction: "IN", body: VALERIA.messages[0].text, templateName: null, buttons: [], image: null, status: "RECEIVED", atSim: AT };
const SENT = { persona: "C01", wamid: "wamid.SIM.1", accepted: true, reason: null, outcomes: ["INTAKE"] };

function inputOf(request: Request): unknown {
  const body = request.postDataJSON() as Record<string, unknown> | null;
  return body?.["0"];
}

interface PhoneWorld {
  messages: Record<string, unknown>[];
  typing: boolean;
}

async function openSimulator(page: Page, world: PhoneWorld, extra: (path: string) => ApiAnswer | undefined = () => undefined) {
  const calls = await routeApi(page, (path) => {
    const special = extra(path);
    if (special !== undefined) return special;
    if (path === "simulator.personas") return { data: PERSONAS };
    if (path === "simulator.threads") return { data: { persona: "C01", messages: world.messages, typing: world.typing } };
    if (path.startsWith("simulator.")) return { data: SENT };
    return NOT_IMPLEMENTED;
  });
  await plantSession(page, GUEST);
  await page.goto("/app/simulator");
  await expect(page.getByRole("heading", { name: copy.views.simulator.title })).toBeVisible();
  return calls;
}

const phone = (page: Page) => page.getByRole("region", { name: simulatorCopy.phone.title(VALERIA.name) });

test.describe("the phone simulator [FL-101]", () => {
  test("[FL-101] lists the 41 personas with their scenario and opens Valeria's phone, labelled “WhatsApp (simulado)”", async ({ page }) => {
    await openSimulator(page, { messages: [], typing: false });
    const list = page.getByRole("navigation", { name: simulatorCopy.personas.title });
    await expect(list.getByRole("button")).toHaveCount(42);
    await expect(list.getByRole("button", { name: /C07 · Florencia Ledesma/ })).toContainText("Comprobante falso");
    await expect(list.getByRole("button", { name: new RegExp(simulatorCopy.personas.unlinked) })).toBeVisible();
    await expect(phone(page).getByText(simulatorCopy.frameLabel, { exact: true })).toBeVisible();
    await expect(phone(page).getByText(simulatorCopy.phone.empty)).toBeVisible();
    await list.getByLabel(simulatorCopy.personas.filter).fill("comprobante falso");
    await expect(list.getByRole("button")).toHaveCount(2);
  });

  test("[FL-101] “Mandar mensaje y comprobante del guion” sends the script text and then the synthetic receipt", async ({ page }) => {
    const world: PhoneWorld = { messages: [], typing: false };
    const calls = await openSimulator(page, world, (path) => {
      if (path === "simulator.attachReceipt") {
        world.messages = [INBOUND, ACK];
        world.typing = true;
      }
      return undefined;
    });
    const text = page.waitForRequest((request) => request.url().includes("/api/simulator.sendText"));
    const receipt = page.waitForRequest((request) => request.url().includes("/api/simulator.attachReceipt"));
    await phone(page).getByRole("button", { name: simulatorCopy.script.sendWithReceipt }).click();
    expect(inputOf(await text)).toEqual({ persona: "C01", text: VALERIA.messages[0].text });
    expect(inputOf(await receipt)).toEqual({ persona: "C01", source: { kind: "SCRIPT" } });
    await expect(page.getByText(simulatorCopy.done.sent)).toBeVisible();
    await expect(phone(page).getByText(/Registré tu reclamo R-2026-000123/)).toBeVisible();
    await expect(phone(page).getByRole("status").filter({ hasText: simulatorCopy.phone.typing })).toBeVisible();
    await expect(phone(page).getByText(simulatorCopy.script.allSent)).toBeVisible();
    const order = calls.map((call) => call.path).filter((path) => path === "simulator.sendText" || path === "simulator.attachReceipt");
    expect(order).toEqual(["simulator.sendText", "simulator.attachReceipt"]);
  });

  test("[FL-101] a tap sends the message and the button's index, never a nonce; “EN” shows the English gloss", async ({ page }) => {
    await openSimulator(page, { messages: [INBOUND, ACK], typing: false });
    const tap = page.waitForRequest((request) => request.url().includes("/api/simulator.tapButton"));
    await phone(page).getByRole("button", { name: simulatorCopy.phone.tap("Sí, a ese email") }).click();
    expect(inputOf(await tap)).toEqual({ persona: "C01", messageId: "msg-l000002", buttonIndex: 0 });
    await expect(page.getByText(simulatorCopy.done.tapped)).toBeVisible();

    await expect(phone(page).getByText(/^I registered your complaint/)).toHaveCount(0);
    await page.getByRole("button", { name: simulatorCopy.gloss.toggleLabel }).click();
    await expect(phone(page).getByText("I registered your complaint R-2026-000123 (payment not reflected). The written answer reaches you no later than jueves 22/10.")).toBeVisible();
    await expect(phone(page).getByText("[Yes, to that email] [Talk to someone]")).toBeVisible();
    await expect(phone(page).getByText(VALERIA.messages[0].en).first()).toBeVisible();
  });

  test("[FL-101] a test image goes under the fixed notice: refused here when too heavy, else presigned, posted and attached", async ({ page }) => {
    const calls = await openSimulator(page, { messages: [], typing: false }, (path) =>
      path === "simulator.presignReceipt" ? { data: { url: UPLOAD_URL, fields: { key: "up/g03/up-01/0.png", "Content-Type": "image/png" }, key: "up/g03/up-01/0.png", maxBytes: 3932160, expiresInSeconds: 300 } } : undefined,
    );
    const posted: string[] = [];
    await page.route(`${UPLOAD_URL}**`, async (route) => {
      posted.push(route.request().method());
      await route.fulfill({ status: 204 });
    });
    await phone(page).getByRole("button", { name: simulatorCopy.composer.attach }).click();
    const attach = phone(page).getByRole("region", { name: simulatorCopy.attach.title });
    await expect(attach.getByRole("note")).toHaveText(simulatorCopy.attach.notice);
    const input = attach.getByLabel(simulatorCopy.attach.own);
    await input.setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(3_932_161, 1) });
    await expect(attach.getByRole("alert")).toHaveText(simulatorCopy.attach.TOO_LARGE);
    await expect(attach.getByRole("button", { name: simulatorCopy.attach.sendOwn })).toBeDisabled();
    await input.setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") });
    await expect(attach.getByRole("alert")).toHaveText(simulatorCopy.attach.UNSUPPORTED);

    await input.setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const presign = page.waitForRequest((request) => request.url().includes("/api/simulator.presignReceipt"));
    const attached = page.waitForRequest((request) => request.url().includes("/api/simulator.attachReceipt"));
    await attach.getByRole("button", { name: simulatorCopy.attach.sendOwn }).click();
    expect(inputOf(await presign)).toEqual({ persona: "C01", contentType: "image/png", sizeBytes: 8 });
    expect(inputOf(await attached)).toEqual({ persona: "C01", source: { kind: "UPLOAD", key: "up/g03/up-01/0.png" } });
    expect(posted).toEqual(["POST"]);
    await expect(page.getByText(simulatorCopy.done.attached)).toBeVisible();
    expect(calls.map((call) => call.path)).not.toContain("simulator.sendText");
  });

  test("[FL-101] a message the channel did not take says why; a world running WhatsApp live turns the simulator off", async ({ page }) => {
    await openSimulator(page, { messages: [], typing: false }, (path) => (path === "simulator.sendText" ? { data: { ...SENT, accepted: false, reason: "RATE_LIMITED" } } : undefined));
    await phone(page).getByLabel(simulatorCopy.composer.label).fill("Hola");
    await phone(page).getByRole("button", { name: simulatorCopy.composer.send }).click();
    await expect(page.getByRole("alert").filter({ hasText: `${simulatorCopy.done.rejected}${simulatorCopy.rejections.RATE_LIMITED}` })).toBeVisible();

    const live = await page.context().newPage();
    await routeApi(live, (path) => (path === "simulator.personas" ? refusal("CONFLICT", 409, "WHATSAPP_LIVE") : NOT_IMPLEMENTED));
    await plantSession(live, GUEST);
    await live.goto("/app/simulator");
    await expect(live.getByRole("alert").filter({ hasText: simulatorCopy.liveMode })).toBeVisible();
    await expect(live.getByRole("region", { name: /Teléfono de/ })).toHaveCount(0);
  });
});
