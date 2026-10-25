// Renders the AWS architecture diagram (docs/assets/architecture/architecture.html, ADR-0021 §13) with
// the installed Chrome at scale 2, after checking its grid rule (layout.ts: horizontal and vertical
// runs that never cross a box):
//
//   submission, English   docs/assets/architecture.png (the README's "Submission notes" and the gallery)
//   public, English       docs/assets/architecture-public.png (the README's body); no mark of the submission
//   public, es and en     packages/web/public/landing/architecture/{es,en}-<width>.{avif,webp} and the
//                         PNG fallback (encode.ts), recorded as `architecture` in the landing's manifest;
//                         no mark of the submission (every `.cds` is hidden) and checked for it
//
//   npm run diagram:render
//
// Run it after changing the HTML; WP-50 runs it again on the final commit and expects no difference.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Page, chromium } from "@playwright/test";
import type { Alt } from "../../packages/web/src/views/landing/manifest";
import { DETERMINISTIC_CHROME_ARGS } from "../landing/capture-console";
import { runAsCommand } from "../landing/cli";
import { assertAvifEncoder, encodePicture } from "../landing/encode";
import { PUBLIC_DIR, readManifest, writeManifest } from "../landing/manifest-file";
import { findNeutralTerms } from "../lint/neutral-surfaces";
import { type Rect, layoutProblems } from "./layout";

const SOURCE = join(import.meta.dirname, "../../docs/assets/architecture/architecture.html");
export const SUBMISSION_PNG = join(import.meta.dirname, "../../docs/assets/architecture.png");
export const PUBLIC_PNG = join(import.meta.dirname, "../../docs/assets/architecture-public.png");
export const PUBLIC_ID = "architecture";
const CANVAS = { width: 1920, height: 1160 } as const;
const SCALE = 2;

export const ARCHITECTURE_ALT: Alt = {
  es: "Arquitectura en AWS: WhatsApp y Amazon SES como canales, eventos ordenados por cliente en colas FIFO, el agente en Amazon Bedrock AgentCore con sus tools, la compuerta de salida por la que pasa todo emisor y los datos con su registro anclado",
  en: "AWS architecture: WhatsApp and Amazon SES as channels, events ordered per customer in FIFO queues, the agent on Amazon Bedrock AgentCore with its tools, the outbound gate every sender goes through and the data with its anchored register",
};

interface Variant {
  readonly variant: "submission" | "public";
  readonly lang: "es" | "en";
}

/** Runs in the page: the rectangles of the boxes and the points of every connector. */
const READ_LAYOUT = `(() => {
  const canvas = document.querySelector("#canvas").getBoundingClientRect();
  const boxes = [...document.querySelectorAll("#canvas .node")].map((node) => {
    const rect = node.getBoundingClientRect();
    return { name: node.querySelector(".t").textContent.trim(), left: rect.left - canvas.left, top: rect.top - canvas.top, right: rect.right - canvas.left, bottom: rect.bottom - canvas.top };
  });
  const wires = [...document.querySelectorAll("#canvas polyline.wire")].map((line) => line.getAttribute("points"));
  const overflow = [...document.querySelectorAll("#canvas .node")].filter((node) => node.scrollHeight > node.clientHeight + 1).map((node) => node.querySelector(".t").textContent.trim());
  return { boxes, wires, overflow, text: document.querySelector("#canvas").innerText };
})()`;

async function shoot(page: Page, { variant, lang }: Variant): Promise<Buffer> {
  await page.goto(`${pathToFileURL(SOURCE).href}?variant=${variant}&lang=${lang}`, { waitUntil: "networkidle" });
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  const layout = await page.evaluate<{ boxes: Rect[]; wires: string[]; overflow: string[]; text: string }>(READ_LAYOUT);
  const problems = [...layoutProblems(layout.wires, layout.boxes), ...layout.overflow.map((name) => `“${name}” does not fit its box (${variant}, ${lang})`)];
  if (variant === "public") problems.push(...findNeutralTerms(`diagram-${lang}`, layout.text).map((finding) => `the public diagram (${lang}) names "${finding.term}"`));
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return page.locator("#canvas").screenshot({ type: "png" });
}

async function main(): Promise<void> {
  assertAvifEncoder();
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome", args: DETERMINISTIC_CHROME_ARGS });
  try {
    const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: SCALE });
    const submission = await shoot(page, { variant: "submission", lang: "en" });
    mkdirSync(dirname(SUBMISSION_PNG), { recursive: true });
    writeFileSync(SUBMISSION_PNG, submission);
    process.stdout.write(`render-architecture: ${SUBMISSION_PNG} (${Math.round(submission.byteLength / 1024)} KB)\n`);
    const publicEn = await shoot(page, { variant: "public", lang: "en" });
    writeFileSync(PUBLIC_PNG, publicEn);
    process.stdout.write(`render-architecture: ${PUBLIC_PNG} (${Math.round(publicEn.byteLength / 1024)} KB)\n`);
    rmSync(join(PUBLIC_DIR, "landing", PUBLIC_ID), { recursive: true, force: true });
    const size = { width: CANVAS.width * SCALE, height: CANVAS.height * SCALE };
    const es = await encodePicture(page, PUBLIC_ID, "es", await shoot(page, { variant: "public", lang: "es" }), size, PUBLIC_DIR);
    const en = await encodePicture(page, PUBLIC_ID, "en", publicEn, size, PUBLIC_DIR);
    writeManifest({ ...readManifest(), architecture: { es, en, alt: ARCHITECTURE_ALT, renderedAt: new Date().toISOString().slice(0, 10) } });
    process.stdout.write("render-architecture: public diagram (es, en) written and recorded in the landing's manifest\n");
  } finally {
    await browser.close();
  }
}

runAsCommand("render-architecture", import.meta.filename, main);
