// What every spec of the deployed stage shares: the site, the two viewports of docs/landing-spec.md §10,
// where the evidence goes, and the checks a public page must pass wherever it is (ADR-0019, ADR-0010):
// no word of the contest, no technical id of the app, no term of the external brand list (read from
// FORBIDDEN_TERMS when the runner has it, reported by its position, never by its text), and never a
// horizontal scroll. Runner tooling, not a Lambda: the environment is the operator's.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, type TestInfo, expect } from "@playwright/test";
import { findTerms, listFromEnv } from "../../../../../scripts/lint/forbidden-terms.ts";
import { findNeutralTerms } from "../../../../../scripts/lint/neutral-surfaces.ts";
import { captureEvidence } from "../../support/evidence";

export const SITE = process.env.POC_SITE ?? "https://reclamo.demo.craftech.io";

export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

export const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "reclamo-e2e-poc");

/** Outside the repository: screenshots and the redacted test lead. */
export const EVIDENCE_DIR = process.env.POC_EVIDENCE_DIR ?? join(OUTPUT_DIR, "evidence");

export type Lang = "es" | "en";

/** `390x844` or `1440x900`: the size of the project the test runs in. */
export function sizeOf(info: TestInfo): string {
  const viewport = info.project.use.viewport ?? VIEWPORTS.desktop;
  return `${viewport.width}x${viewport.height}`;
}

export const isPhone = (info: TestInfo): boolean => info.project.name === "phone";

/**
 * The page's evidence in the evidence directory, as a visitor scrolls it (support/evidence.ts): the
 * stitched page with every window settled (reveals shown, the hero's loop on its last stage, nothing
 * moving) and, on the landing, one shot per step of the product tour. Returns every path.
 */
export async function evidence(page: Page, name: string): Promise<string[]> {
  await scrollThrough(page);
  const shots = await captureEvidence(page, EVIDENCE_DIR, name);
  return [...shots.page, ...shots.tourSteps];
}

/** Everything a visitor can read: the text, the title, the alternative texts and the accessible labels. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts = [document.title, document.body.innerText];
    for (const element of document.querySelectorAll("[alt], [aria-label], [title], meta[name='description'], meta[property^='og:']")) {
      for (const name of ["alt", "aria-label", "title", "content"]) {
        const value = element.getAttribute(name);
        if (value) parts.push(value);
      }
    }
    return parts.join("\n");
  });
}

/** No contest word, no technical id, no forbidden brand (by position only), no unfilled marker. */
export async function expectNeutralPage(page: Page, where: string): Promise<void> {
  const text = await visibleText(page);
  expect(findNeutralTerms(where, text), `${where}: contest words or the app's technical id`).toEqual([]);
  const list = listFromEnv(process.env);
  if (list.ok) {
    const positions = findTerms(where, text, list.terms).map((finding) => finding.term);
    expect(positions, `${where}: positions of forbidden terms (the list is outside the repository)`).toEqual([]);
  }
  expect(text, `${where}: an unfilled marker`).not.toMatch(/a confirmar|to be confirmed|lorem ipsum|\[pendiente\]|\[pending\]/i);
  expect(text, `${where}: an unfilled marker`).not.toMatch(/\bTBD\b|\bXXX\b/);
}

/** The document is never wider than the window (checked at the top and after scrolling to the end). */
export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(sizes.scroll, `${where}: scrollWidth ${sizes.scroll} > clientWidth ${sizes.client}`).toBeLessThanOrEqual(sizes.client);
}

/** Scrolls the whole page in steps (so every reveal and lazy image fires), then back to the top. */
export async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.6));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => window.scrollTo(0, 0));
}
