// The console captures of the landing (docs/landing-spec.md §7): one entry per id of the captures
// manifest, with the view it shows, the moment of the guided tour's walk it is taken at
// (capture-world.ts), what the capture does in the view before the frame (scroll to a section, open an
// email, bring a message of the phone into sight), the part of the frame it keeps (the tour's first two
// steps keep only the phone, down to the one bubble the step is about: the customer's message, then the
// acknowledgement; never the operator's script panel or composer; the console steps keep only the block
// the step is about, shot at about the width the landing draws it so its text stays legible) and its
// alternative text in both languages. Every word a step looks for comes from the console's own copy, its single source.
//
// The metrics step has no capture: until a measured batch exists its render shows the design's targets,
// each labelled "meta" (docs/landing-spec.md §7); a capture of /app/metrics would show "n/a".
import type { Locator, Page } from "@playwright/test";
import { PERSONA_SCRIPTS } from "@reclamo/bff/copy/persona-scripts";
import { complaintCopy } from "../../packages/web/src/views/complaint/copy";
import { emailsCopy } from "../../packages/web/src/views/emails/copy";
import { registerCopy } from "../../packages/web/src/views/register/copy";
import type { Alt, Viewport } from "../../packages/web/src/views/landing/manifest";
import { tapeCopy } from "../../packages/web/src/views/tape/copy";
import type { TourPersona } from "../../packages/web/src/views/tour/steps";
import { MAIN_STORY } from "../../packages/web/src/views/tour/steps";
import type { Moment } from "./capture-world";

export interface CaptureContext {
  complaintId(persona: TourPersona): Promise<string>;
}

export interface CaptureSpec {
  /** The console path, or how to find it in the world (a complaint's page). */
  readonly view: string | ((context: CaptureContext) => Promise<string>);
  readonly moment: Moment;
  readonly alt: Alt;
  /** Taken in the mobile viewport too (the tour's steps); the gallery's own pictures are desktop only. */
  readonly mobile: boolean;
  /** What the capture does in the view once it has loaded, before the frame. */
  readonly prepare?: (page: Page) => Promise<void>;
  /**
   * The part of the viewport the frame keeps (CSS pixels); the whole viewport when absent. Several parts
   * are laid side by side on desktop and stacked on a phone, in one frame (capture-console.ts `compose`).
   */
  readonly clip?: (page: Page) => Promise<Clip | readonly Clip[]>;
  /** The CSS viewport of each frame; the manifest's VIEWPORTS when absent. */
  readonly viewports?: Readonly<Record<Viewport, Size>>;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The phone's thread (views/simulator/Phone.tsx): the scrolling list of bubbles. */
const THREAD = '[aria-live="polite"].overflow-y-auto';

/** The bits of the DOM the steps touch, typed here: the scripts compile without the DOM library. */
interface Scrollable {
  scrollIntoView(options: { readonly block: "start" | "center"; readonly behavior: "instant" }): void;
}
interface Thread {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly offsetTop: number;
  querySelectorAll(selector: "li"): Iterable<{ readonly offsetTop: number; readonly textContent: string | null }>;
}

const toTop = (element: Scrollable) => element.scrollIntoView({ block: "start", behavior: "instant" });

/** Scrolls the page so `selector` starts at the top of the viewport. */
async function scrollPageTo(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate(toTop);
}

/** Room kept under the step's bubble and above it in the thread: less than the 8 px between two bubbles. */
const CROP_MARGIN = 6;

/** Valeria's script message: the bubble the main story's thread must open with. */
const MAIN_STORY_TEXT = PERSONA_SCRIPTS.find((script) => script.id === MAIN_STORY.persona)?.messages[0].text ?? "";

/** Brings the phone into view and scrolls its thread so the first bubble that says `text` is on top. */
function phoneAt(text: string | undefined) {
  return async (page: Page): Promise<void> => {
    const thread = page.locator(THREAD).first();
    await thread.locator("li").filter(text === undefined ? {} : { hasText: text }).first().waitFor();
    // Messages of one paused minute come in arrival order: the story must read message, receipt, answer.
    const first = (await thread.locator("li").first().innerText()).trim();
    if (!first.startsWith(MAIN_STORY_TEXT)) throw new Error("the phone does not open with Valeria's message (same-minute order): take the capture again");
    await page.locator("section[aria-label]").filter({ has: page.locator(THREAD) }).first().evaluate(toTop);
    await thread.evaluate(
      (element: Thread, { wanted, margin }: { readonly wanted: string | null; readonly margin: number }) => {
        const bubble = wanted === null ? undefined : [...element.querySelectorAll("li")].find((item) => item.textContent?.includes(wanted) === true);
        element.scrollTop = wanted === null ? 0 : bubble ? bubble.offsetTop - element.offsetTop - margin : element.scrollHeight;
      },
      { wanted: text ?? null, margin: CROP_MARGIN },
    );
  };
}

/**
 * The phone (its frame label, the persona and the thread) from its top down to the bottom of the first
 * bubble that says `text` (the first bubble when `undefined`): the step's one message, without the bubbles
 * after it, the script panel or the composer.
 */
function phoneDownTo(text: string | undefined) {
  return async (page: Page): Promise<Clip> => {
    const phone = await page.locator("section[aria-label]").filter({ has: page.locator(THREAD) }).first().boundingBox();
    const bubbles = page.locator(THREAD).first().locator("li");
    const bubble = await (text === undefined ? bubbles.first() : bubbles.filter({ hasText: text }).first()).boundingBox();
    if (!phone || !bubble) throw new Error("the phone or its bubble is not on screen: take the capture again");
    const top = Math.max(0, phone.y);
    return { x: phone.x, y: top, width: phone.width, height: Math.ceil(bubble.y + bubble.height + CROP_MARGIN - top) };
  };
}

/**
 * The console steps of the tour (3 to 6) at about the width the landing draws them: the 620 px sticky
 * panel from 1024 px and a 342 px column on a phone. Both are below the console's `md`, so there is no
 * sidebar; at 2x their text reaches the landing near its own size instead of a 1280 px frame squeezed
 * into the panel. Tall, so the block a step keeps is on screen whole.
 */
export const PANEL_VIEWPORTS: Readonly<Record<Viewport, Size>> = { desktop: { width: 640, height: 2400 }, mobile: { width: 360, height: 2400 } };
/** The evidence step lays its two cards side by side on desktop: each one at half the panel. */
export const EVIDENCE_VIEWPORTS: Readonly<Record<Viewport, Size>> = { desktop: { width: 400, height: 2400 }, mobile: PANEL_VIEWPORTS.mobile };

/** Room kept around a kept block: its border and shadow, not the view around it. */
const BLOCK_MARGIN = 8;

type Pick = (page: Page) => Locator;
const css =
  (selector: string): Pick =>
  (page) =>
    page.locator(selector).first();

/** The box around the given elements (they must be on screen whole), with BLOCK_MARGIN of room. */
async function boxAround(page: Page, picks: readonly Pick[]): Promise<Clip> {
  const boxes = await Promise.all(picks.map((pick) => pick(page).boundingBox()));
  const size = page.viewportSize();
  const shown = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
  if (size === null || shown.length !== picks.length) throw new Error("a block of the capture is not on screen: take the capture again");
  const left = Math.max(0, Math.min(...shown.map((box) => box.x)) - BLOCK_MARGIN);
  const top = Math.max(0, Math.min(...shown.map((box) => box.y)) - BLOCK_MARGIN);
  const right = Math.min(size.width, Math.max(...shown.map((box) => box.x + box.width)) + BLOCK_MARGIN);
  const bottom = Math.max(...shown.map((box) => box.y + box.height)) + BLOCK_MARGIN;
  if (bottom > size.height) throw new Error(`a block is taller than the capture's viewport (${size.height} px): raise it`);
  return { x: left, y: top, width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

/** One frame: the smallest box around these elements (the step's block, from its first to its last part). */
function around(...picks: readonly Pick[]) {
  return (page: Page): Promise<Clip> => boxAround(page, picks);
}

/** Several blocks of the same view, each kept whole, that the frame lays side by side (desktop) or stacked (phone). */
function blocks(...picks: readonly Pick[]) {
  return (page: Page): Promise<readonly Clip[]> => Promise.all(picks.map((pick) => boxAround(page, [pick])));
}

/** The evidence cards (views/complaint/EvidenceSection.tsx): the read receipt and the settlement line that matches it. */
const evidenceCard = (kind: "RECEIPT_IMAGE" | "SETTLEMENT_MATCH") => `#evidence article[aria-label="${complaintCopy.evidence.kind[kind]}"]`;
const RECEIPT_CARD = css(evidenceCard("RECEIPT_IMAGE"));
const MATCHED_LINE: Pick = (page) =>
  page
    .locator(evidenceCard("SETTLEMENT_MATCH"))
    .filter({ hasText: complaintCopy.evidence.settlement.result.MATCHED ?? "" })
    .first();

/** The email detail (views/emails/EmailDetail.tsx): from the subject and its delivery proof down to the SES events. */
const EMAIL_DETAIL = `article[aria-label="${emailsCopy.detail.title}"]`;
const EMAIL_EVENTS = `${EMAIL_DETAIL} section[aria-label="${emailsCopy.detail.events}"]`;

/** Opens the email of the list whose subject says `subject` and brings its detail to the top (below the list on a phone). */
function emailOpen(subject: string) {
  return async (page: Page): Promise<void> => {
    await page.getByRole("row").filter({ hasText: subject }).first().click();
    await page.locator(EMAIL_EVENTS).first().waitFor();
    await scrollPageTo(page, EMAIL_DETAIL);
  };
}

/** The tape's cards (below `md`) of the WhatsApp collection rule: the block in red and its reroute. */
const BLOCKED_CARD = '[data-tape-card]:has([data-tape-banner="BLOCKED"])';
const REROUTED_CARD = '[data-tape-card]:has([data-tape-banner="REROUTED"])';
const COLLECTION_RULE = "CH-WA-NO-COLLECTION";

/** Filters the tape to the WhatsApp collection rule and brings its blocked decision to the top. */
async function blockedInView(page: Page): Promise<void> {
  await page.getByLabel(tapeCopy.filters.rule).first().selectOption(COLLECTION_RULE);
  await page.locator(BLOCKED_CARD).first().waitFor();
  await page.locator(REROUTED_CARD).first().waitFor();
  await scrollPageTo(page, `${BLOCKED_CARD}, ${REROUTED_CARD}`);
}

/** The register's export (views/register/ExportPanel.tsx): its button down to the verified result and its files. */
const EXPORT_BUTTON: Pick = (page) => page.getByRole("button", { name: registerCopy.export.button }).first();
const EXPORT_RESULT: Pick = (page) => page.getByText(registerCopy.export.linkNote).first().locator("..");

/** Exports the register from its own panel and waits for the verified files. */
async function exportRegister(page: Page): Promise<void> {
  await EXPORT_BUTTON(page).click();
  await page.getByRole("link", { name: registerCopy.export.csv }).first().waitFor({ timeout: 30_000 });
  await EXPORT_BUTTON(page).evaluate(toTop);
}

export const CAPTURES: Readonly<Record<string, CaptureSpec>> = {
  "tour-01-whatsapp": {
    view: "/app/simulator",
    moment: "2",
    mobile: true,
    prepare: phoneAt(undefined),
    clip: phoneDownTo(undefined),
    alt: { es: "Mensaje de WhatsApp donde Valeria reporta que su pago no se refleja", en: "WhatsApp message where Valeria reports her payment isn't showing" },
  },
  "tour-02-ack": {
    view: "/app/simulator",
    moment: "2",
    mobile: true,
    prepare: phoneAt(MAIN_STORY.number),
    clip: phoneDownTo(MAIN_STORY.number),
    alt: { es: "Acuse automático con el número de reclamo y el plazo", en: "Automatic acknowledgement with the complaint number and deadline" },
  },
  "tour-03-evidence": {
    view: async (context) => `/app/complaints/${await context.complaintId("C01")}`,
    moment: "4",
    mobile: true,
    prepare: (page) => scrollPageTo(page, "#evidence"),
    clip: blocks(RECEIPT_CARD, MATCHED_LINE),
    viewports: EVIDENCE_VIEWPORTS,
    alt: { es: "Comprobante leído junto a la línea de rendición que lo confirma", en: "Read receipt next to the settlement line that confirms it" },
  },
  "tour-04-email": {
    view: "/app/emails",
    moment: "4",
    mobile: true,
    prepare: emailOpen(`Reclamo ${MAIN_STORY.number} · Respuesta escrita`),
    clip: around(css(`${EMAIL_DETAIL} > div`), css(EMAIL_EVENTS)),
    viewports: PANEL_VIEWPORTS,
    alt: { es: "Respuesta escrita por email con el PDF adjunto y la constancia de entrega", en: "Written answer by email with the attached PDF and delivery proof" },
  },
  "tour-05-blocked": {
    view: "/app/tape",
    moment: "2b",
    mobile: true,
    prepare: blockedInView,
    clip: around(css(BLOCKED_CARD), css(REROUTED_CARD)),
    viewports: PANEL_VIEWPORTS,
    alt: { es: "Intento de cobranza por WhatsApp bloqueado y reencaminado a un aviso formal por email", en: "Attempted WhatsApp collection message blocked and rerouted to a formal email notice" },
  },
  "tour-06-register": {
    view: "/app/register",
    moment: "10",
    mobile: true,
    prepare: exportRegister,
    clip: around(EXPORT_BUTTON, EXPORT_RESULT),
    viewports: PANEL_VIEWPORTS,
    alt: { es: "Registro de reclamos exportado con su cadena de hash verificada", en: "Complaint register exported with its verified hash chain" },
  },
  "gallery-console-inbox": {
    view: "/app/inbox",
    moment: "9:complaint",
    mobile: false,
    alt: { es: "Bandeja de reclamos con el plazo restante de cada uno", en: "Complaint inbox with each one's remaining deadline" },
  },
  "gallery-console-approvals": {
    view: "/app/approvals",
    moment: "7:approvals",
    mobile: false,
    alt: { es: "Pedido de aprobación sobre el tope del agente", en: "An approval request above the agent's cap" },
  },
};

/** The ids in manifest order. */
export const CAPTURE_IDS: readonly string[] = Object.keys(CAPTURES);

