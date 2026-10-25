// FL-102 · the evidence capture the deployed suite takes of the landing (support/evidence.ts), run here
// on the local landing with motion on, at 390x844 and 1440x900: every window is shot with its reveals
// shown and the hero's loop on its last stage (the capture fails on a window that never settles, the
// blank hero card a phone used to get), and the product tour is shot once per step with that step's own
// visual (the sticky panel shows one visual per window). The PNGs go to the run's output directory.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { TOUR_STEPS } from "../src/views/landing/tour/tour-steps.ts";
import { OUTPUT_DIR } from "./support/env";
import { captureEvidence, settleWindow } from "./support/evidence";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const DIR = join(OUTPUT_DIR, "evidence");

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function heroStagesOn(page: Page): Promise<boolean> {
  return page.locator('#inicio .hero-stage[data-on="false"]').count().then((off) => off === 0);
}

test.use({ reducedMotion: "no-preference" });

for (const viewport of VIEWPORTS) {
  test(`[FL-102] the landing's evidence at ${viewport.width}x${viewport.height}: settled windows and one shot per tour step`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The hero's card is caught on screen with every stage of its loop on, never between stages.
    await page.locator("#inicio figure").scrollIntoViewIfNeeded();
    await settleWindow(page, "hero");
    expect(await heroStagesOn(page)).toBe(true);

    const shots = await captureEvidence(page, DIR, `local-landing-${viewport.name}`);
    expect(shots.page.length).toBeGreaterThan(0);
    expect(shots.tourSteps).toHaveLength(TOUR_STEPS.length);
    // Each step's shot shows that step: no two are the same picture.
    expect(new Set(shots.tourSteps.map(digest)).size).toBe(TOUR_STEPS.length);
    // Nothing was left hidden by a reveal anywhere on the page.
    expect(await page.locator('[data-reveal="pending"]').count()).toBe(0);
  });
}
