// The files of one picture of the landing (docs/landing-spec.md §7-§8): from a 2x screenshot, AVIF and
// WebP at 1x and 2x for the `srcset` and a PNG at 1x as the fallback, under
// public/landing/<id>/<variant>[-<width>].<ext>. Resizing and the WebP and PNG encodings are done by the
// same installed Chrome that took the screenshot (a canvas: no image library to install); AVIF by
// libavif's `avifenc`, single-threaded so the same input always gives the same bytes. Returns the
// picture as the manifest records it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { type Picture, pictureSrc } from "../../packages/web/src/views/landing/manifest";
import { publicPath } from "./manifest-file";

export const WEBP_QUALITY = 0.82;
export const AVIF_QUALITY = 55;
/** Largest file the landing takes for one width of one picture: a bigger one slows the page for no gain. */
export const MAX_BYTES = 900 * 1024;

const AVIFENC = "avifenc";

/** Fails before any capture when libavif's encoder is not installed. */
export function assertAvifEncoder(): void {
  try {
    execFileSync(AVIFENC, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("avifenc (libavif) is not installed: `brew install libavif` or your package manager's libavif-bin");
  }
}

/** The widths a picture `width` pixels wide (a 2x screenshot) is served at: 1x and 2x. */
export function widthsOf(width: number): [number, number] {
  return [Math.round(width / 2), width];
}

/** Runs in the page: draws the PNG at `width` and encodes it as `type`; answers base64. */
const RESIZE = `async ({ png, width, type, quality }) => {
  const image = new Image();
  image.src = "data:image/png;base64," + png;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((image.naturalHeight * width) / image.naturalWidth);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality).split(",")[1];
}`;

async function resized(page: Page, png: Buffer, width: number, type: "image/png" | "image/webp"): Promise<Buffer> {
  const args = { png: png.toString("base64"), width, type, quality: WEBP_QUALITY };
  return Buffer.from(await page.evaluate<string>(`(${RESIZE})(${JSON.stringify(args)})`), "base64");
}

function write(src: string, bytes: Buffer, publicDir: string): void {
  if (bytes.byteLength > MAX_BYTES) throw new Error(`${src}: ${Math.round(bytes.byteLength / 1024)} KB, over the ${MAX_BYTES / 1024} KB budget`);
  const path = publicPath(src, publicDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function avif(png: Buffer): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "reclamo-avif-"));
  try {
    const input = join(dir, "in.png");
    const output = join(dir, "out.avif");
    writeFileSync(input, png);
    execFileSync(AVIFENC, ["-q", String(AVIF_QUALITY), "-s", "6", "-j", "1", "--ignore-exif", "--ignore-xmp", input, output], { stdio: "ignore" });
    return readFileSync(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Encodes a 2x screenshot `width`×`height` as the picture `<id>/<variant>`, written under `publicDir`. */
export async function encodePicture(page: Page, id: string, variant: string, screenshot: Buffer, size: { readonly width: number; readonly height: number }, publicDir: string): Promise<Picture> {
  const picture: Picture = { width: size.width, height: size.height, avif: [], webp: [], png: pictureSrc(id, variant, "png") };
  const [oneX] = widthsOf(size.width);
  for (const width of widthsOf(size.width)) {
    const lossless = width === size.width ? screenshot : await resized(page, screenshot, width, "image/png");
    if (width === oneX) write(picture.png, lossless, publicDir);
    const webp = { src: pictureSrc(id, variant, "webp", width), w: width };
    write(webp.src, await resized(page, screenshot, width, "image/webp"), publicDir);
    picture.webp.push(webp);
    const avifSource = { src: pictureSrc(id, variant, "avif", width), w: width };
    write(avifSource.src, avif(lossless), publicDir);
    picture.avif.push(avifSource);
  }
  return picture;
}
