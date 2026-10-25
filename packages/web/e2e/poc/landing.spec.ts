// FL-127 / FL-128 on the deployed stage · the landing as a visitor reads it (docs/landing-spec.md §10,
// ADR-0021 §2): es and en, with `prefers-reduced-motion` reduce and no-preference, at 390 × 844 and
// 1440 × 900. Never a horizontal scroll (also with the phone menu open), the three calls to action of
// the CTO's decisions ("Probar Reclamo en regla" → /signup with the visit's campaign, "Ingresar" →
// /login, "Hablemos" → Craftech's contact form with its placement's UTM in a new tab), the legal links,
// the video section's rules when it exists, and a neutral page. Full-page evidence of each language and
// size, plus one reduced-motion pair.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { LANDING_COPY } from "../../src/views/landing/copy.ts";
import { CONTACT_PLACEMENTS, CRAFTECH_CONTACT_URL, contactHref } from "../../src/views/landing/links.ts";
import { EVIDENCE_DIR, type Lang, evidence, expectNeutralPage, expectNoHorizontalScroll, isPhone, scrollThrough, sizeOf } from "./support/site";

const MOTIONS = ["no-preference", "reduce"] as const;
type Motion = (typeof MOTIONS)[number];

const landingPath = (lang: Lang) => (lang === "en" ? "/?lang=en" : "/");
const signupPath = (lang: Lang) => (lang === "en" ? "/signup?lang=en" : "/signup");
const loginPath = (lang: Lang) => (lang === "en" ? "/login?lang=en" : "/login");

async function openLanding(page: Page, lang: Lang, motion: Motion, query = ""): Promise<void> {
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto(`${landingPath(lang)}${query === "" ? "" : `${lang === "en" ? "&" : "?"}${query}`}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function hrefsOf(page: Page, name: string): Promise<string[]> {
  return page.getByRole("link", { name }).evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
}

for (const lang of ["es", "en"] as const) {
  for (const motion of MOTIONS) {
    test(`[FL-127] landing ${lang} · motion ${motion}: no sideways scroll, the CTAs, neutral`, async ({ page }, info) => {
      const copy = LANDING_COPY[lang];
      await openLanding(page, lang, motion);
      await expect(page.locator("html")).toHaveAttribute("lang", lang === "en" ? "en" : /^es/);
      await expectNoHorizontalScroll(page, `${lang} top`);

      // "Probar Reclamo en regla" → /signup, "Ingresar" → /login, in the page's language.
      const tries = await hrefsOf(page, copy.cta.try);
      expect(tries.length, "product CTAs").toBeGreaterThanOrEqual(2);
      for (const href of tries) expect(href).toBe(signupPath(lang));
      const signIns = await hrefsOf(page, copy.cta.signIn);
      expect(signIns.length, "sign-in links").toBeGreaterThanOrEqual(1);
      for (const href of signIns) expect(href).toBe(loginPath(lang));

      // "Hablemos" → https://craftech.io/contact/ with the placement's UTM, in a new tab, never mailto.
      const talks = page.getByRole("link", { name: new RegExp(`^${copy.cta.talk}`) });
      expect(await talks.count(), "contact CTAs").toBeGreaterThanOrEqual(3);
      for (const link of await talks.all()) {
        const href = (await link.getAttribute("href")) ?? "";
        expect(href.startsWith(`${CRAFTECH_CONTACT_URL}?`), href).toBe(true);
        const placement = new URL(href).searchParams.get("utm_content");
        expect(CONTACT_PLACEMENTS as readonly (string | null)[]).toContain(placement);
        expect(href).toBe(contactHref(placement as (typeof CONTACT_PLACEMENTS)[number]));
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", /noopener/);
      }
      expect(await page.locator('a[href^="mailto:"]').count(), "mailto links").toBe(0);

      // Legal pages from the footer.
      const footer = page.getByRole("contentinfo");
      await expect(footer.getByRole("link", { name: copy.footer.privacy, exact: true })).toHaveAttribute("href", /^\/legal\/privacy\.html/);
      await expect(footer.getByRole("link", { name: copy.footer.terms, exact: true })).toHaveAttribute("href", /^\/legal\/terms\.html/);

      await scrollThrough(page);
      await expectNoHorizontalScroll(page, `${lang} after scrolling`);
      if (motion === "reduce") {
        // Everything readable without waiting for an animation (docs/landing-spec.md §10 case 3).
        expect(await page.locator('[data-reveal="pending"]').count(), "reveals still pending").toBe(0);
      }
      // The video section, when the manifest names a video: no preload, a poster, no autoplay.
      const video = page.locator("#video video");
      if ((await video.count()) > 0) {
        await expect(video).toHaveAttribute("preload", "none");
        await expect(video).toHaveAttribute("poster", /.+/);
        expect(await video.getAttribute("autoplay")).toBeNull();
      }
      await expectNeutralPage(page, `landing ${lang}`);

      if (motion === "no-preference") await evidence(page, `landing-${lang}-${sizeOf(info)}`);
      else if (lang === "es") await evidence(page, `landing-${lang}-reduced-motion-${sizeOf(info)}`);
    });
  }

  test(`[FL-127] landing ${lang}: the phone menu opens without overflow and carries the three CTAs`, async ({ page }, info) => {
    test.skip(!isPhone(info), "the menu exists below 1024 px");
    const copy = LANDING_COPY[lang];
    await openLanding(page, lang, "no-preference");
    const menu = page.getByRole("button", { name: copy.nav.menu });
    await menu.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expectNoHorizontalScroll(page, `${lang} menu open`);
    await expect(drawer.getByRole("link", { name: copy.cta.try })).toHaveAttribute("href", signupPath(lang));
    await expect(drawer.getByRole("link", { name: copy.cta.signIn })).toHaveAttribute("href", loginPath(lang));
    await expect(drawer.getByRole("link", { name: new RegExp(`^${copy.cta.talk}`) })).toHaveAttribute("href", contactHref("drawer"));
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
  });
}

test("[FL-127] the visit's campaign travels to /signup, and nothing else does", async ({ page }) => {
  await openLanding(page, "es", "reduce", "utm_source=qa-poc&utm_medium=e2e&utm_campaign=surfaces&fbclid=nope");
  const href = (await hrefsOf(page, LANDING_COPY.es.cta.try))[0] ?? "";
  const url = new URL(href, "https://x.invalid");
  expect(url.pathname).toBe("/signup");
  expect(Object.fromEntries(url.searchParams)).toEqual({ utm_source: "qa-poc", utm_medium: "e2e", utm_campaign: "surfaces" });
});

test("[FL-127] the desktop tour shows each step's own visual, loaded, when its text crosses the centre", async ({ page }, info) => {
  test.skip(isPhone(info), "the sticky tour exists from 1024 px");
  await openLanding(page, "es", "no-preference");
  const steps = await page.locator("[data-step-index]").count();
  expect(steps, "tour steps").toBe(7);
  for (let index = 0; index < steps; index += 1) {
    await page.locator(`#paso-${index + 1}`).evaluate((step) => step.scrollIntoView({ block: "center", behavior: "instant" }));
    await expect(page.locator(`[data-step-index="${index}"]`)).toHaveAttribute("aria-current", "step");
    const visual = page.locator(".tour-visual[data-state=active]");
    await expect(visual).toHaveCount(1);
    await expect(visual).toBeInViewport();
    const image = visual.locator("img");
    if ((await image.count()) > 0) await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    // Each step after the cross-fade (index.css `.tour-visual`): the stitched full page keeps one visual per window.
    await page.waitForTimeout(800);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(EVIDENCE_DIR, `landing-es-1440x900-tour-step${index + 1}.png`) });
  }
});

test("[FL-127] the language switch keeps the header inside 360 px", async ({ page }, info) => {
  test.skip(!isPhone(info), "a phone width");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const lang of ["es", "en"] as const) {
    await openLanding(page, lang, "no-preference");
    await expectNoHorizontalScroll(page, `${lang} at 360 px`);
    const banner = await page.getByRole("banner").boundingBox();
    expect((banner?.x ?? 0) + (banner?.width ?? 0)).toBeLessThanOrEqual(360);
  }
});
