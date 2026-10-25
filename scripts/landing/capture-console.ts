// The landing's console captures (docs/landing-spec.md §7, WP-44): the real console, built and served on
// 127.0.0.1 over the deterministic guest world of the guided tour's replay (capture-world.ts,
// capture-server.ts), shot with the installed Chrome at each capture's moment of the walk, in desktop
// 1280x800 and, for the tour's steps, mobile 390x844, at 2x, with reduced motion and Buenos Aires time;
// then encoded (encode.ts) under public/landing/<id>/ and recorded in public/landing/manifest.json.
//
//   FORBIDDEN_TERMS="$(cat <list outside the repo>)" npm run landing:capture
//   … npm run landing:capture -- --only tour-03-evidence,tour-04-email    only these
//   … npm run landing:capture -- --out <dir>     raw PNGs there; public/ and the manifest untouched
//
// Fails closed without FORBIDDEN_TERMS. Every request outside the local origin is aborted and fails the
// run; the text of each frame is checked before anything is written (frame-check.ts). Only the seed's
// receipts appear: the world is walked by the tour's scripts and nothing is ever uploaded.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, type Page, chromium } from "@playwright/test";
import { type CaptureItem, type Picture, VIEWPORTS, type Viewport, withMedia } from "../../packages/web/src/views/landing/manifest";
import { runAsCommand } from "./cli";
import { buildConsole } from "./console-build";
import { plantSessionScript } from "./console-session";
import { type CaptureWorld, type Moment, createCaptureWorld } from "./capture-world";
import { startCaptureServer } from "./capture-server";
import { CAPTURES, CAPTURE_IDS, type CaptureSpec, type Clip } from "./captures";
import { assertAvifEncoder, encodePicture } from "./encode";
import { frameProblems, requiredTerms } from "./frame-check";
import { PUBLIC_DIR, readManifest, writeManifest } from "./manifest-file";

export const SCALE = 2;
/** Software raster in one pass, sRGB and no LCD text: the same page gives the same pixels every run. */
export const DETERMINISTIC_CHROME_ARGS = ["--force-color-profile=srgb", "--disable-gpu", "--disable-partial-raster", "--disable-skia-runtime-opts", "--disable-lcd-text", "--disable-threaded-scrolling", "--disable-threaded-animation", "--run-all-compositor-stages-before-draw"];

export interface CaptureOptions {
  readonly only: ReadonlySet<string> | undefined;
  readonly out: string | undefined;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureOptions {
  const { values } = parseArgs({ args: [...argv], options: { only: { type: "string" }, out: { type: "string" } }, strict: true });
  const only = values.only === undefined ? undefined : new Set(values.only.split(",").map((id) => id.trim()).filter((id) => id !== ""));
  for (const id of only ?? []) if (!CAPTURE_IDS.includes(id)) throw new Error(`--only names an unknown capture: ${id}`);
  return { only, out: values.out };
}

export interface Frame {
  readonly id: string;
  readonly viewport: Viewport;
  readonly png: Buffer;
}

/** The viewports of a capture: desktop always, mobile for the tour's steps. */
export function viewportsOf(spec: CaptureSpec): Viewport[] {
  return spec.mobile ? ["desktop", "mobile"] : ["desktop"];
}

/** Gap between the parts of a composed frame, in CSS pixels. */
const PART_GAP = 12;

/**
 * One frame out of several screenshots of the same view (each at the capture's 2x): side by side or
 * stacked, at their own size, on a blank page of the same context. No pixel is redrawn.
 */
export async function compose(page: Page, parts: readonly Buffer[], direction: "row" | "column"): Promise<Buffer> {
  const images = parts
    .map((png) => {
      const { width } = pngSize(png);
      return `<img alt="" style="display:block;width:${width / SCALE}px" src="data:image/png;base64,${png.toString("base64")}">`;
    })
    .join("");
  await page.setContent(`<div id="frame" style="display:inline-flex;flex-direction:${direction};align-items:flex-start;gap:${PART_GAP}px;margin:0">${images}</div>`);
  await page.evaluate("Promise.all([...document.images].map((image) => image.decode()))");
  return page.locator("#frame").screenshot({ type: "png", animations: "disabled" });
}

async function shoot(browser: Browser, origin: string, world: CaptureWorld, id: string, spec: CaptureSpec, viewport: Viewport, terms: Parameters<typeof frameProblems>[2]): Promise<Frame> {
  const escaped: string[] = [];
  const context = await browser.newContext({ viewport: spec.viewports?.[viewport] ?? VIEWPORTS[viewport], deviceScaleFactor: SCALE, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires", colorScheme: "light", reducedMotion: "reduce" });
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      escaped.push(url.host);
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(plantSessionScript({ idToken: world.guestToken(), accessToken: "capture-only", expiresAt: Date.now() + 3_600_000 }));
    const page = await context.newPage();
    const path = typeof spec.view === "string" ? spec.view : await spec.view(world);
    await page.goto(`${origin}${path}`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await spec.prepare?.(page);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.evaluate("document.fonts.ready.then(() => undefined)");
    if (escaped.length > 0) throw new Error(`${id}: the console tried to reach ${[...new Set(escaped)].join(", ")}`);
    const alerts = await page.getByRole("alert").filter({ visible: true }).allInnerTexts();
    if (alerts.length > 0) throw new Error(`${id}/${viewport}: the view shows an error instead of its content: ${alerts.join(" | ").slice(0, 300)}`);
    const problems = frameProblems(`${id}/${viewport}`, await page.locator("body").innerText(), terms);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const clip = await spec.clip?.(page);
    const shot = (part?: Clip) => page.screenshot({ type: "png", animations: "disabled", caret: "hide", ...(part ? { clip: part } : {}) });
    if (!Array.isArray(clip)) return { id, viewport, png: await shot(clip as Clip | undefined) };
    const parts: Buffer[] = [];
    for (const part of clip) parts.push(await shot(part));
    return { id, viewport, png: await compose(await context.newPage(), parts, viewport === "desktop" ? "row" : "column") };
  } finally {
    await context.close();
  }
}

/** Walks the world and takes every wanted capture at its moment. */
async function takeFrames(browser: Browser, origin: string, world: CaptureWorld, ids: readonly string[], terms: Parameters<typeof frameProblems>[2]): Promise<{ frames: Frame[]; problems: readonly string[]; blocked: readonly Moment[] }> {
  const frames: Frame[] = [];
  const moments = new Set(ids.map((id) => CAPTURES[id]?.moment).filter((moment): moment is Moment => moment !== undefined));
  const report = await world.walk(moments, async (moment) => {
    for (const id of ids) {
      const spec = CAPTURES[id];
      if (spec?.moment !== moment) continue;
      for (const viewport of viewportsOf(spec)) {
        frames.push(await shoot(browser, origin, world, id, spec, viewport, terms));
        process.stdout.write(`${id}/${viewport}  taken at ${moment}\n`);
      }
    }
  });
  return { frames, ...report };
}

function headCommit(): string {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

/** Width and height of a PNG, from its IHDR chunk (a cropped frame is smaller than the viewport). */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.toString("ascii", 12, 16) !== "IHDR") throw new Error("not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Encodes the frames of each capture and records them in the manifest. */
async function publish(page: Page, frames: readonly Frame[]): Promise<void> {
  let manifest = readManifest();
  const capturedAt = new Date().toISOString().slice(0, 10);
  const commit = headCommit();
  for (const id of [...new Set(frames.map((frame) => frame.id))]) {
    const spec = CAPTURES[id];
    if (spec === undefined) continue;
    rmSync(join(PUBLIC_DIR, "landing", id), { recursive: true, force: true });
    const pictures: Partial<Record<Viewport, Picture>> = {};
    for (const frame of frames.filter((candidate) => candidate.id === id)) pictures[frame.viewport] = await encodePicture(page, id, frame.viewport, frame.png, pngSize(frame.png), PUBLIC_DIR);
    if (pictures.desktop === undefined) throw new Error(`${id}: no desktop frame`);
    const entry: CaptureItem = { status: "capture", desktop: pictures.desktop, ...(pictures.mobile ? { mobile: pictures.mobile } : {}), alt: spec.alt, origin: "local", capturedAt, commit };
    manifest = withMedia(manifest, id, entry);
    process.stdout.write(`${id}: encoded\n`);
  }
  writeManifest(manifest);
}

async function main(): Promise<void> {
  const options = parseCaptureArgs(process.argv.slice(2));
  const terms = requiredTerms();
  if (options.out === undefined) assertAvifEncoder();
  const ids = CAPTURE_IDS.filter((id) => options.only === undefined || options.only.has(id));
  const build = await buildConsole();
  const world = await createCaptureWorld();
  const server = await startCaptureServer(world.tour.flow, build.dir);
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome", args: DETERMINISTIC_CHROME_ARGS });
  try {
    const { frames, problems, blocked } = await takeFrames(browser, server.origin, world, ids, terms);
    for (const problem of problems) process.stdout.write(`warning: ${problem}\n`);
    if (options.out !== undefined) {
      const dir = resolve(options.out);
      mkdirSync(dir, { recursive: true });
      for (const frame of frames) writeFileSync(join(dir, `${frame.id}-${frame.viewport}.png`), frame.png);
    } else {
      const encoder = await browser.newPage();
      await publish(encoder, frames);
    }
    const missing = ids.filter((id) => !frames.some((frame) => frame.id === id));
    if (missing.length > 0) throw new Error(`not captured (their step broke a promise of the tour: ${blocked.join(", ") || "none"}): ${missing.join(", ")}`);
  } finally {
    await browser.close();
    await server.close();
    build.remove();
  }
}

runAsCommand("capture-console", import.meta.filename, main);
