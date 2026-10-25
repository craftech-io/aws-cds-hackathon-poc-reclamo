// FL-093 · the email viewer on the UI server (tests/ui-server): the real `appRouter` over the
// in-process worlds. The email is produced by the real path — a guest of `g05` tries a collection
// reminder by WhatsApp, the gate blocks it and the guest reroutes it to the formal notice by email,
// which leaves through the SES fake with its PDF — so what the viewer shows is what was sent. A guest
// world is used so the demo story (C09 in `demo`) stays untouched for the other specs; the formal
// notice goes once every 7 days, so a notice already sent in this run is reused.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { sessionTokens, staffClaims } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { emailsCopy } from "../src/views/emails/copy.ts";
import { TOKENS_KEY } from "./support/session";

const SUBJECT = "Aviso formal de deuda · Jarilla (ficticio)";

async function signIn(page: Page, worldId: string, role: StaffRole): Promise<void> {
  const tokens = sessionTokens(staffClaims(worldId, role));
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(tokens) },
  );
}

async function api(request: APIRequestContext, worldId: string, role: StaffRole, path: string, input: unknown, kind: "query" | "mutation") {
  const headers = { authorization: `Bearer ${sessionTokens(staffClaims(worldId, role)).idToken}` };
  const response =
    kind === "mutation"
      ? await request.post(`/api/${path}`, { headers, data: input })
      : await request.get(`/api/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
  const body = (await response.json()) as { result?: { data: unknown }; error?: { data?: { code?: string; reason?: string | null } } };
  return { status: response.status(), data: body.result?.data, error: body.error?.data };
}

interface Listed {
  readonly emails: readonly { readonly mailId: string; readonly customerId: string; readonly kind: string; readonly subject: string }[];
}

/** The formal debt notice of C09 in `g05`, sent through the gate by the real reroute (or the one already sent). */
async function formalNotice(request: APIRequestContext) {
  const listed = async () => ((await api(request, "g05", "GUEST", "emails.list", { limit: 200 }, "query")).data as Listed).emails.find((email) => email.kind === "COLLECTION_NOTICE_EMAIL");
  const existing = await listed();
  if (existing !== undefined) return existing;
  const queued = await api(request, "g05", "GUEST", "customers.compose", { customerId: "cus-0009", kind: "COLLECTION_REMINDER", channel: "WHATSAPP", text: "Martín, tenés la cuota 3 vencida. Regularizá hoy." }, "mutation");
  expect(queued.status).toBe(200);
  await request.post("/__e2e/settle");
  const blocked = (await api(request, "g05", "GUEST", "tape.list", { decision: "BLOCKED", ruleId: "CH-WA-NO-COLLECTION", limit: 20 }, "query")).data as { entries: { tapeId: string; messageId?: string }[] };
  const entry = blocked.entries.find((candidate) => candidate.messageId === (queued.data as { messageId: string }).messageId);
  expect(entry).toBeDefined();
  const rerouted = await api(request, "g05", "GUEST", "conversation.reroute", { tapeId: entry?.tapeId, route: "FORMAL_EMAIL", customerId: "cus-0009" }, "mutation");
  expect(rerouted.status).toBe(200);
  await request.post("/__e2e/settle");
  await request.post("/__e2e/settle");
  const sent = await listed();
  expect(sent, "the reroute sent the formal notice by email").toBeDefined();
  return sent as NonNullable<typeof sent>;
}

test.describe("email viewer", () => {
  // One formal notice per 7 days for a customer: the tests share it, so they run one after the other.
  test.describe.configure({ mode: "serial" });

  test("shows an email of the world exactly as it left: headers, sandboxed HTML, text and the SHA-256 of the .eml [FL-093]", async ({ page, request }) => {
    const notice = await formalNotice(request);
    const detail = (await api(request, "g05", "GUEST", "emails.get", { customerId: notice.customerId, mailId: notice.mailId }, "query")).data as {
      integrity: { sha256: string; recorded: string; matches: boolean };
      view: { html: string; text: string };
    };
    expect(detail.integrity.matches).toBe(true);

    await signIn(page, "g05", "GUEST");
    await page.goto("/app/emails");
    await expect(page.getByRole("heading", { name: copy.views.emails.title })).toBeVisible();
    const table = page.getByRole("table", { name: emailsCopy.list.caption });
    await table.getByRole("row").filter({ hasText: SUBJECT }).first().click();

    const email = page.getByRole("article", { name: emailsCopy.detail.title });
    await expect(email.getByRole("heading", { name: SUBJECT })).toBeVisible();
    await expect(email.getByText(/^[a-z0-9]\*\*\*@simulator\.amazonses\.com$/)).toBeVisible();
    await expect(email.getByText(/Jarilla \(ficticio\) vía Reclamo en regla/)).toBeVisible();
    await expect(email.locator(`[data-eml-sha256="${detail.integrity.sha256}"]`)).toHaveText(detail.integrity.sha256);
    await expect(email.getByText(emailsCopy.detail.matches)).toBeVisible();
    // Each clock by its name: the send on the world's simulated time and on the real one, and every SES
    // event on the real clock it was stamped with (never formatted as if it were simulated).
    await expect(email.getByText(emailsCopy.detail.date, { exact: true })).toBeVisible();
    await expect(email.getByText(emailsCopy.detail.dateReal, { exact: true })).toBeVisible();
    await expect(email.getByText(emailsCopy.detail.eventsLead)).toBeVisible();

    const frame = email.locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("title", emailsCopy.detail.htmlFrame);
    expect(await frame.getAttribute("src")).toBeNull();
    await expect(page.frameLocator(`iframe[title="${emailsCopy.detail.htmlFrame}"]`).getByText("Hola Martín:")).toBeVisible();
    await expect(email.locator("pre")).toContainText("Te enviamos este aviso formal");
  });

  test("shows each SES event on the real clock it was stamped with, next to the send's real instant [FL-093]", async ({ page, request }) => {
    const notice = await formalNotice(request);
    // The local SES fake emits no events: the stage's answer is completed with the two SES would send,
    // a real-clock SEND and DELIVERY a few seconds after the record was written.
    await page.route("**/api/emails.get**", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as unknown;
      const withEvents = (answer: { result?: { data?: { sentAtReal?: string | null; events?: unknown[] } } }) => {
        const data = answer.result?.data;
        if (data?.sentAtReal) {
          const sent = Date.parse(data.sentAtReal);
          data.events = [
            { type: "SEND", atReal: new Date(sent + 1_000).toISOString() },
            { type: "DELIVERY", atReal: new Date(sent + 4_000).toISOString() },
          ];
        }
        return answer;
      };
      await route.fulfill({ response, json: Array.isArray(body) ? body.map(withEvents) : withEvents(body as Parameters<typeof withEvents>[0]) });
    });
    await signIn(page, "g05", "GUEST");
    await page.goto("/app/emails");
    await page.getByRole("table", { name: emailsCopy.list.caption }).getByRole("row").filter({ hasText: notice.subject }).first().click();
    const email = page.getByRole("article", { name: emailsCopy.detail.title });
    const events = email.getByRole("region", { name: emailsCopy.detail.events }).getByRole("listitem");
    await expect(events).toHaveCount(2);
    await expect(events.filter({ hasText: emailsCopy.events.DELIVERY })).toContainText(emailsCopy.detail.realClock);
    for (const text of await events.allInnerTexts()) expect(text).toContain(emailsCopy.detail.realClock);
    const real = email.getByText(emailsCopy.detail.dateReal, { exact: true }).locator("xpath=following-sibling::dd[1]");
    await expect(real).toContainText(emailsCopy.detail.realClock);
  });

  test("downloads the attached PDF through a blob, byte for byte the one sent [FL-093]", async ({ page, request }) => {
    const notice = await formalNotice(request);
    const detail = (await api(request, "g05", "GUEST", "emails.get", { customerId: notice.customerId, mailId: notice.mailId }, "query")).data as { view: { attachments: { filename: string; sha256: string }[] } };
    const attachment = detail.view.attachments[0];
    expect(attachment).toBeDefined();

    await signIn(page, "g05", "GUEST");
    await page.goto("/app/emails");
    await page.getByRole("table", { name: emailsCopy.list.caption }).getByRole("row").filter({ hasText: SUBJECT }).first().click();
    const email = page.getByRole("article", { name: emailsCopy.detail.title });
    const [download] = await Promise.all([page.waitForEvent("download"), email.getByRole("button", { name: emailsCopy.detail.download }).first().click()]);
    expect(download.url()).toMatch(/^blob:/);
    expect(download.suggestedFilename()).toBe(attachment?.filename);
    const bytes = await readFile((await download.path()) ?? "");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(attachment?.sha256);
  });

  test("lists only the world's own emails: another world neither lists nor opens it [FL-093]", async ({ page, request }) => {
    const notice = await formalNotice(request);
    const other = (await api(request, "g03", "GUEST", "emails.list", { limit: 200 }, "query")).data as Listed;
    expect(other.emails.some((email) => email.mailId === notice.mailId)).toBe(false);
    const opened = await api(request, "g03", "GUEST", "emails.get", { customerId: notice.customerId, mailId: notice.mailId }, "query");
    expect(opened.status).toBe(404);
    expect(opened.data).toBeUndefined();

    await signIn(page, "g03", "GUEST");
    await page.goto("/app/emails");
    await expect(page.getByRole("heading", { name: copy.views.emails.title })).toBeVisible();
    await expect(page.getByText(emailsCopy.detail.none)).toBeVisible();
    await expect(page.locator(`text=${notice.mailId}`)).toHaveCount(0);
  });
});
