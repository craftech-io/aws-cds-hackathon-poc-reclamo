// FL-102 · the commercial landing and its legal pages in a real browser (docs/landing-spec.md §10,
// tests/cases/FL-102.md): section order and the document's language, no horizontal scroll at 360,
// 390 and 1440 px in both languages with the menu closed and open (with the real console captures in
// the page), the accessible menu, the sticky tour on desktop with its captures and the stacked one on
// a phone with the phone-sized captures (and, for a step without a capture, the compact glossed
// render), everything readable with reduced motion, the calls to action (a full page load of /signup,
// Craftech's contact form per placement, no mailto), the gallery of real captures and the diagram in
// the zoom viewer, and the legal pages. FL-128: no contest word in the rendered text.
import { type Page, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findNeutralTerms } from "../../../scripts/lint/neutral-surfaces.ts";
import { LANDING_COPY } from "../src/views/landing/copy.ts";
import { CONTACT_PLACEMENTS, contactHref } from "../src/views/landing/links.ts";
import { LandingManifest } from "../src/views/landing/manifest.ts";

type Lang = "es" | "en";
const LANGS: readonly Lang[] = ["es", "en"];
const SECTIONS = ["inicio", "problema", "recorrido", "que-hace", "reglas", "impacto", "video", "integracion", "simulado", "empezar"];
const MANIFEST = LandingManifest.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../public/landing/manifest.json", import.meta.url)), "utf8")));
const TOUR_IDS = Object.keys(MANIFEST.media).filter((id) => id.startsWith("tour-"));
/** The 1x width of a capture's desktop picture. */
function captureWidth(id: string): number {
  const item = MANIFEST.media[id];
  return item?.status === "capture" ? item.desktop.width / 2 : 0;
}

/** The tour's steps that are real captures (the metrics stay the render of the targets until a measured batch). */
const CAPTURED_IDS = TOUR_IDS.filter((id) => MANIFEST.media[id]?.status === "capture");

/** The manifest as it was before the captures: each tour step drawn as a render. */
async function withRenders(page: Page): Promise<void> {
  await page.route("**/landing/manifest.json", (route) =>
    route.fulfill({ json: { ...MANIFEST, media: Object.fromEntries(TOUR_IDS.map((id) => [id, { status: "render", component: "TapeRow", replacedBy: id, due: "2026-10-16" }])) } }),
  );
}

/** The `currentSrc` and the decoded width of the picture of a figure, once it has loaded. */
async function loadedPicture(page: Page, id: string): Promise<{ src: string; width: number }> {
  const image = page.locator(`[data-media="${id}"] img`).first();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  return image.evaluate((element: HTMLImageElement) => ({ src: element.currentSrc, width: element.naturalWidth }));
}

async function open(page: Page, lang: Lang, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(lang === "en" ? "/?lang=en" : "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** Scrolls the whole page in steps so every observer fires, then back to the top. */
async function walk(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  });
}

async function overflow(page: Page): Promise<{ scroll: number; client: number }> {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
}

const menuButton = (page: Page, lang: Lang) => page.getByRole("button", { name: LANDING_COPY[lang].nav.menu, exact: true });
const dialog = (page: Page, lang: Lang) => page.getByRole("dialog", { name: LANDING_COPY[lang].nav.menu });

test.describe("landing [FL-102]", () => {
  test.use({ reducedMotion: "no-preference" });

  for (const lang of LANGS) {
    test(`[FL-102] lays out the sections in order with one h1 and lang=${lang}`, async ({ page }) => {
      await open(page, lang);
      expect(await page.locator("html").getAttribute("lang")).toBe(lang);
      expect(await page.locator("main > section").evaluateAll((sections) => sections.map((section) => section.id))).toEqual(SECTIONS);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      for (const id of SECTIONS.slice(1)) await expect(page.locator(`section#${id} h2`).first()).toBeVisible();
      // The product video: no preload, its poster, controls and no autoplay; the hero's third call to action goes to it.
      const video = page.locator("#video video");
      await expect(video).toHaveAttribute("preload", "none");
      await expect(video).toHaveAttribute("poster", MANIFEST.video?.poster ?? "");
      await expect(video).toHaveAttribute("controls", "");
      expect(await video.getAttribute("autoplay")).toBeNull();
      await expect(page.locator(`#video source[src="${MANIFEST.video?.src ?? ""}"]`)).toHaveAttribute("type", "video/mp4");
      await expect(page.locator('#inicio a[data-cta="watch"]')).toHaveAttribute("href", "#video");
      await expect(page.locator('#inicio a[data-cta="watch"]')).toHaveText(LANDING_COPY[lang].cta.watch);
      await expect(page.locator("#galeria figure")).toHaveCount(Object.values(MANIFEST.media).filter((item) => item.status === "capture").length);
      await expect(page.locator('#integracion [data-media="architecture"]')).toBeAttached();
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
    });

    for (const [width, height] of [[360, 800], [390, 844], [1440, 900]] as const) {
      test(`[FL-102] never scrolls sideways at ${width} px in ${lang}, with the menu closed and open`, async ({ page }) => {
        await open(page, lang, width, height);
        await walk(page);
        let sizes = await overflow(page);
        expect(sizes.scroll, "closed").toBeLessThanOrEqual(sizes.client);
        if (width < 1024) {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await menuButton(page, lang).click();
          await expect(dialog(page, lang)).toBeVisible();
          sizes = await overflow(page);
          expect(sizes.scroll, "open").toBeLessThanOrEqual(sizes.client);
          const box = await dialog(page, lang).boundingBox();
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 0.5);
        }
      });
    }
  }

  test("[FL-102] the menu keeps the focus inside, closes on Escape and on the backdrop and gives the focus back", async ({ page }) => {
    await open(page, "es", 390, 844);
    await menuButton(page, "es").click();
    const menu = dialog(page, "es");
    await expect(menu).toBeVisible();
    for (let press = 0; press < 12; press += 1) {
      expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press(press % 3 === 2 ? "Shift+Tab" : "Tab");
    }
    await expect(menu.getByRole("link", { name: LANDING_COPY.es.cta.try })).toHaveAttribute("href", "/signup");
    await expect(menu.locator('[data-placement="drawer"]')).toHaveAttribute("href", contactHref("drawer"));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(menuButton(page, "es")).toBeFocused();
    await page.setViewportSize({ width: 768, height: 1024 });
    await menuButton(page, "es").click();
    await expect(dialog(page, "es")).toBeVisible();
    await page.mouse.click(40, 500);
    await expect(dialog(page, "es")).toHaveCount(0);
    await expect(menuButton(page, "es")).toBeFocused();
  });

  test("[FL-102] on desktop the sticky panel follows the step whose centre crosses the viewport, with each step's real capture", async ({ page }) => {
    await open(page, "es", 1440, 900);
    for (const [index, id] of [[0, "tour-01-whatsapp"], [4, "tour-05-blocked"]] as const) {
      await page.locator(`li[data-step-index="${index}"]`).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await expect(page.locator(`.tour-visual[data-state="active"] [data-media="${id}"]`)).toBeVisible();
      await expect(page.locator(`li[data-step-index="${index}"]`)).toHaveAttribute("aria-current", "step");
      const picture = await loadedPicture(page, id);
      expect(picture.src, id).toMatch(new RegExp(`/landing/${id}/desktop-\\d+\\.avif$`));
      await expect(page.locator(`.tour-visual[data-state="active"] [data-media="${id}"]`)).toContainText(LANDING_COPY.es.tour.captureNote);
      // Step 1 is the phone cropped to the customer's message: never drawn wider than its own 1x width.
      if (id === "tour-01-whatsapp") expect((await page.locator(`[data-media="${id}"] img`).first().boundingBox())?.width ?? 0).toBeLessThanOrEqual(captureWidth(id));
    }
    // The closing step: the design's targets, each labelled "meta", until a measured batch exists.
    await page.locator('li[data-step-index="6"]').evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    const metrics = page.locator('.tour-visual[data-state="active"] [data-render="tour-07-metrics"]');
    await expect(metrics).toBeVisible();
    await expect(metrics).toContainText(LANDING_COPY.es.tour.renderNote);
    await expect(metrics.getByText(LANDING_COPY.es.impact.target, { exact: false })).toHaveCount(4);
    await expect(metrics).not.toContainText("n/a");
    expect(await page.locator(".tour-visual").count()).toBeLessThanOrEqual(3);
  });

  test("[FL-102] on a phone the steps stack with the phone-sized captures, inside the screen", async ({ page }) => {
    await open(page, "en", 390, 844);
    await expect(page.locator("li[data-step-index]")).toHaveCount(0);
    for (const id of CAPTURED_IDS) {
      const picture = await loadedPicture(page, id);
      expect(picture.src, id).toMatch(new RegExp(`/landing/${id}/mobile-\\d+\\.avif$`));
      const box = await page.locator(`#recorrido [data-media="${id}"]`).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(390);
    }
    await expect(page.getByText(LANDING_COPY.en.tour.captureNote).first()).toBeVisible();
  });

  test("[FL-102] on a phone in English a step without its capture is a compact, glossed render", async ({ page }) => {
    await withRenders(page);
    await open(page, "en", 390, 844);
    await expect(page.locator("li[data-step-index]")).toHaveCount(0);
    const gate = page.locator('[data-render="tour-05-blocked"]');
    await gate.scrollIntoViewIfNeeded();
    await expect(gate.locator("table")).toBeHidden();
    await expect(gate.getByText("BLOQUEADO · BLOCKED").first()).toBeVisible();
    await expect(page.locator('[data-render="tour-06-register"] table')).toBeHidden();
    await expect(page.getByText("WhatsApp (simulado) · WhatsApp (simulated)").first()).toBeVisible();
    for (const id of ["tour-05-blocked", "tour-06-register", "tour-07-metrics"]) {
      const box = await page.locator(`[data-render="${id}"]`).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), id).toBeLessThanOrEqual(390);
    }
  });

  test("[FL-102] sends 'Probar Reclamo en regla' to /signup by a full page load and each 'Hablemos' to its placement", async ({ page }) => {
    await open(page, "es", 1440, 900);
    expect(await page.content()).not.toContain("mailto:");
    for (const placement of CONTACT_PLACEMENTS.filter((name) => name !== "drawer" && name !== "signup-unavailable")) {
      const link = page.locator(`[data-placement="${placement}"]`);
      await expect(link).toHaveAttribute("href", contactHref(placement));
      await expect(link).toHaveAttribute("target", "_blank");
    }
    await expect(page.locator('a[data-cta="sign-in"]').first()).toHaveAttribute("href", "/login");
    const documentRequest = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/signup");
    await page.locator("#inicio").getByRole("link", { name: LANDING_COPY.es.cta.try }).click();
    expect((await documentRequest).resourceType()).toBe("document");
  });
});

test.describe("landing with reduced motion [FL-102]", () => {
  test.use({ reducedMotion: "reduce" });

  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    test(`[FL-102] shows every piece of content at once at ${width} px, with no element left at opacity 0`, async ({ page }) => {
      await open(page, "es", width, height);
      await walk(page);
      const hidden = await page.evaluate(() =>
        [...document.querySelectorAll("main *")]
          .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).opacity === "0")
          .map((element) => element.outerHTML.slice(0, 120)),
      );
      expect(hidden).toEqual([]);
      await expect(page.getByText(LANDING_COPY.es.tour.steps.metrics.title, { exact: true }).first()).toBeVisible();
      await expect(page.locator('[data-render="tour-07-metrics"]').first()).toBeVisible();
    });
  }
});

test.describe("gallery and zoom [FL-102]", () => {
  test("[FL-102] shows the real captures in the gallery and walks them by keyboard and by swipe", async ({ page }) => {
    await open(page, "es", 1440, 900);
    const gallery = page.locator("#galeria");
    await gallery.scrollIntoViewIfNeeded();
    // The viewer walks the captures in manifest order; it is opened on the first full-viewport one.
    const ids = Object.keys(MANIFEST.media).filter((id) => MANIFEST.media[id]?.status === "capture");
    const first = ids.findIndex((id) => captureWidth(id) === 1280);
    const alt = (index: number) => (MANIFEST.media[ids[first + index] ?? ""] as { alt: { es: string } } | undefined)?.alt.es ?? "";
    await gallery.getByRole("button", { name: `${LANDING_COPY.es.zoom.open}: ${alt(0)}` }).click();
    await expect(page.getByRole("dialog", { name: alt(0) })).toBeVisible();
    await expect.poll(() => page.locator("dialog img").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const zoomed = await page.locator("dialog img").boundingBox();
    expect((zoomed?.width ?? 0) > 900 && (zoomed?.y ?? -1) >= 0 && (zoomed?.y ?? 0) + (zoomed?.height ?? 0) <= 900, "the zoomed capture is large and fits the screen").toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: alt(1) })).toBeVisible();
    await page.locator("dialog picture").evaluate((picture) => {
      const options = { bubbles: true, pointerType: "touch", isPrimary: true };
      picture.dispatchEvent(new PointerEvent("pointerdown", { ...options, clientX: 500 }));
      picture.dispatchEvent(new PointerEvent("pointerup", { ...options, clientX: 380 }));
    });
    await expect(page.getByRole("dialog", { name: alt(2) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(await page.locator("#galeria img").evaluateAll((images) => images.every((image) => image.getAttribute("loading") === "lazy"))).toBe(true);
  });

  test("[FL-102] opens the architecture diagram in its language in the zoom viewer", async ({ page }) => {
    for (const lang of LANGS) {
      await open(page, lang, 390, 844);
      const figure = page.locator('#integracion [data-media="architecture"]');
      const picture = await loadedPicture(page, "architecture");
      expect(picture.src).toMatch(new RegExp(`/landing/architecture/${lang}-(1920|3840)\\.avif$`));
      await figure.getByRole("button").click();
      await expect(page.getByRole("dialog", { name: MANIFEST.architecture?.alt[lang] ?? "" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("legal pages [FL-102]", () => {
  for (const path of ["/legal/privacy.html", "/legal/terms.html"]) {
    test(`[FL-102] ${path} carries both languages`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator("section#es[lang=es] h1")).toBeVisible();
      await expect(page.locator("section#en[lang=en] h1")).toBeAttached();
      const sizes = await overflow(page);
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
      if (path.includes("privacy")) {
        for (const fact of ["Ciudad Autónoma de Buenos Aires, Argentina", "sales@craftech.io", "24 meses", "24 months", "Estados Unidos", "United States"]) await expect(page.getByText(fact).first()).toBeAttached();
      }
    });
  }
});

test.describe("neutral surfaces [FL-128]", () => {
  for (const path of ["/", "/?lang=en", "/legal/privacy.html", "/legal/terms.html"]) {
    test(`[FL-128] ${path} names no contest word in its rendered text`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      await walk(page);
      const text = await page.evaluate(() => document.body.innerText);
      expect(findNeutralTerms(path, text)).toEqual([]);
    });
  }
});
