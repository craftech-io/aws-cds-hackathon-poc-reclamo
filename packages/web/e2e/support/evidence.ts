// Screenshots that show a page as a visitor sees it once its motion has played (docs/landing-spec.md §4):
// the deployed suite's evidence (poc/support/site.ts) and the local spec that guards it
// (landing-evidence.spec.ts) share this. The page is shot one window at a time and the windows are
// stitched; before each window every reveal in it is shown, the hero's loop is caught with all its
// stages on, and the page must be still (no running transition, no DOM change for a moment). The
// product tour is then shot once per step, with that step active, because its sticky panel shows a
// single visual per window. A window that never settles fails the capture instead of saving a blank.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect } from "@playwright/test";

/** Chrome cannot paint a surface taller than 16,384 px: a longer page is captured in parts. */
const MAX_SHOT_HEIGHT = 15_000;
/** The page counts as still after this long without a DOM change or a running transition. */
const QUIET_MS = 300;
/** The hero's loop lasts 4 s (motion/timing.ts): enough to reach its last stage from any point. */
const SETTLE_TIMEOUT_MS = 6_000;

export interface EvidenceShots {
  /** The stitched page (one path, or `-partN` paths for a long page). */
  readonly page: string[];
  /** One shot per step of the product tour, in order (`-tour-stepN`). */
  readonly tourSteps: string[];
}

/**
 * Shows every reveal that touches the window, then waits until no hero stage in the window is off, no
 * finite animation runs and the DOM has been quiet for `QUIET_MS`. Throws when the window never settles.
 */
export async function settleWindow(page: Page, where: string): Promise<void> {
  const settled = await page.evaluate(
    async ({ quietMs, timeoutMs }) => {
      const inWindow = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight;
      };
      for (const element of document.querySelectorAll<HTMLElement>('[data-reveal="pending"]')) if (inWindow(element)) element.dataset.reveal = "shown";
      let lastChange = performance.now();
      const observer = new MutationObserver(() => {
        lastChange = performance.now();
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      const deadline = performance.now() + timeoutMs;
      try {
        for (;;) {
          const now = performance.now();
          const heroOff = [...document.querySelectorAll('.hero-stage[data-on="false"]')].some(inWindow);
          const moving = document.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
          const pending = [...document.querySelectorAll('[data-reveal="pending"]')].some(inWindow);
          if (!heroOff && !moving && !pending && now - lastChange >= quietMs) return true;
          if (now > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        observer.disconnect();
      }
    },
    { quietMs: QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS },
  );
  if (!settled) throw new Error(`${where}: the window never settled (a reveal, the hero's loop or a transition kept moving)`);
}

/** Paints the window-sized tiles onto one canvas (in a blank page of the same context) and returns the PNG. */
async function stitch(page: Page, width: number, height: number, tiles: ReadonlyArray<{ readonly y: number; readonly png: Buffer }>): Promise<Buffer> {
  const canvasPage = await page.context().newPage();
  try {
    const dataUrl = await canvasPage.evaluate(
      async ({ width, height, tiles }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no 2d context");
        for (const tile of tiles) {
          const image = new Image();
          image.src = `data:image/png;base64,${tile.png}`;
          await image.decode();
          context.drawImage(image, 0, tile.y);
        }
        return canvas.toDataURL("image/png");
      },
      { width, height, tiles: tiles.map((tile) => ({ y: tile.y, png: tile.png.toString("base64") })) },
    );
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  } finally {
    await canvasPage.close();
  }
}

/** Hides (or shows again) the sticky header, so only the first window of a stitched shot carries it. */
async function bannerVisibility(page: Page, visibility: "hidden" | ""): Promise<void> {
  await page.evaluate((value) => {
    for (const element of document.querySelectorAll<HTMLElement>("[role=banner], header")) {
      const position = getComputedStyle(element).position;
      if (position === "sticky" || position === "fixed") element.style.visibility = value;
    }
  }, visibility);
}

async function stitchedPage(page: Page, dir: string, name: string): Promise<string[]> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const tiles: Array<{ y: number; png: Buffer }> = [];
  try {
    for (let target = 0; target < height; target += viewport.height) {
      // Instant, whatever the page's `scroll-behavior`: the tile is drawn where the window really is.
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), target);
      const y = await page.evaluate(() => Math.round(window.scrollY));
      await settleWindow(page, `${name} at y=${y}`);
      tiles.push({ y, png: await page.screenshot() });
      if (tiles.length === 1) await bannerVisibility(page, "hidden");
      if (y + viewport.height >= height) break;
    }
  } finally {
    await bannerVisibility(page, "");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  }
  const parts = Math.max(1, Math.ceil(height / MAX_SHOT_HEIGHT));
  const partHeight = Math.ceil(height / parts);
  const paths: string[] = [];
  for (let part = 0; part < parts; part += 1) {
    const top = part * partHeight;
    const bottom = Math.min(height, top + partHeight);
    const inPart = tiles.filter((tile) => tile.y < bottom && tile.y + viewport.height > top).map((tile) => ({ y: tile.y - top, png: tile.png }));
    const path = join(dir, parts === 1 ? `${name}.png` : `${name}-part${part + 1}.png`);
    writeFileSync(path, await stitch(page, viewport.width, bottom - top, inPart));
    paths.push(path);
  }
  return paths;
}

/**
 * Each step of the product tour (`#recorrido li[id^=paso-]`) with its visual: on a wide screen the step is
 * brought to the middle of the window until the sticky panel shows it (`aria-current="step"`) and the
 * window is shot; stacked on a phone, the step's own block (visual and text) is shot.
 */
async function tourSteps(page: Page, dir: string, name: string): Promise<string[]> {
  const steps = page.locator('#recorrido li[id^="paso-"]');
  const count = await steps.count();
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const step = steps.nth(index);
    await step.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    const sticky = (await step.getAttribute("data-step-index")) !== null;
    if (sticky) await expect(step, `${name}: tour step ${index + 1} is the active one`).toHaveAttribute("aria-current", "step");
    await settleWindow(page, `${name} tour step ${index + 1}`);
    const path = join(dir, `${name}-tour-step${index + 1}.png`);
    writeFileSync(path, sticky ? await page.screenshot() : await step.screenshot());
    paths.push(path);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  return paths;
}

/** The stitched page and, when it has the product tour, one shot per tour step; all PNGs under `dir`. */
export async function captureEvidence(page: Page, dir: string, name: string): Promise<EvidenceShots> {
  mkdirSync(dir, { recursive: true });
  const shots = await stitchedPage(page, dir, name);
  return { page: shots, tourSteps: await tourSteps(page, dir, name) };
}
