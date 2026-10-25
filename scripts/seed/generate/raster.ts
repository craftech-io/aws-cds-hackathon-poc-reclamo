// A tiny RGB raster for the synthetic receipts: rectangles, circles, triangles, text with the
// embedded bitmap font, rotation, a box-blur approximation of a Gaussian and seeded noise. Integer
// and IEEE arithmetic only, no system fonts, no native image library: the same input gives the same
// pixels on every machine running the pinned Node version.
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from "../lib/font";
import type { RgbImage } from "../lib/png";
import type { Rng } from "./rng";

export type Rgb = readonly [number, number, number];

export class Raster implements RgbImage {
  readonly pixels: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.pixels = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  set(x: number, y: number, [r, g, b]: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 3;
    this.pixels[at] = r;
    this.pixels[at + 1] = g;
    this.pixels[at + 2] = b;
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx += 1) this.set(xx, yy, color);
    }
  }

  circle(cx: number, cy: number, radius: number, color: Rgb): void {
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let x = cx - radius; x <= cx + radius; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) this.set(x, y, color);
    }
  }

  /** Filled triangle by barycentric test over its bounding box. */
  triangle(points: readonly [readonly [number, number], readonly [number, number], readonly [number, number]], color: Rgb): void {
    const [[x1, y1], [x2, y2], [x3, y3]] = points;
    const area = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
    if (area === 0) return;
    for (let y = Math.min(y1, y2, y3); y <= Math.max(y1, y2, y3); y += 1) {
      for (let x = Math.min(x1, x2, x3); x <= Math.max(x1, x2, x3); x += 1) {
        const a = ((x2 - x) * (y3 - y) - (x3 - x) * (y2 - y)) / area;
        const b = ((x3 - x) * (y1 - y) - (x1 - x) * (y3 - y)) / area;
        if (a >= 0 && b >= 0 && a + b <= 1) this.set(x, y, color);
      }
    }
  }

  /** Width in pixels of `text` drawn at `scale`. */
  static textWidth(text: string, scale: number): number {
    const count = [...text].length;
    return count === 0 ? 0 : count * (GLYPH_WIDTH + 1) * scale - scale;
  }

  /** Draws `text` (uppercased) with its top-left corner at (x, y); returns the height used. */
  text(x: number, y: number, text: string, scale: number, color: Rgb): number {
    let cursor = x;
    for (const character of text) {
      const rows = glyph(character);
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < GLYPH_WIDTH; rx += 1) if (row[rx] === "#") this.rect(cursor + rx * scale, y + ry * scale, scale, scale, color);
      });
      cursor += (GLYPH_WIDTH + 1) * scale;
    }
    return GLYPH_HEIGHT * scale;
  }

  /** Text centred horizontally on the raster. */
  centred(y: number, text: string, scale: number, color: Rgb): number {
    return this.text(Math.floor((this.width - Raster.textWidth(text, scale)) / 2), y, text, scale, color);
  }

  /** Rotates the whole raster by `degrees` around its centre (bilinear), filling the corners. */
  rotate(degrees: number, fill: Rgb): void {
    const source = Uint8Array.from(this.pixels);
    const angle = (degrees * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cx = (this.width - 1) / 2;
    const cy = (this.height - 1) / 2;
    const sample = (x: number, y: number, channel: number): number => {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return fill[channel] ?? 0;
      return source[(y * this.width + x) * 3 + channel] ?? 0;
    };
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const sx = cos * (x - cx) + sin * (y - cy) + cx;
        const sy = -sin * (x - cx) + cos * (y - cy) + cy;
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const at = (y * this.width + x) * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          const top = sample(x0, y0, channel) * (1 - fx) + sample(x0 + 1, y0, channel) * fx;
          const bottom = sample(x0, y0 + 1, channel) * (1 - fx) + sample(x0 + 1, y0 + 1, channel) * fx;
          this.pixels[at + channel] = Math.round(top * (1 - fy) + bottom * fy);
        }
      }
    }
  }

  /** Gaussian blur of standard deviation `sigma`, approximated by three box blurs per axis. */
  blur(sigma: number): void {
    for (const size of boxSizes(sigma)) {
      this.boxPass(Math.floor((size - 1) / 2), true);
      this.boxPass(Math.floor((size - 1) / 2), false);
    }
  }

  private boxPass(radius: number, horizontal: boolean): void {
    const source = Uint8Array.from(this.pixels);
    const length = horizontal ? this.width : this.height;
    const lines = horizontal ? this.height : this.width;
    const window = 2 * radius + 1;
    for (let line = 0; line < lines; line += 1) {
      const index = (position: number): number => {
        const clamped = Math.min(length - 1, Math.max(0, position));
        return (horizontal ? line * this.width + clamped : clamped * this.width + line) * 3;
      };
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let position = -radius; position <= radius; position += 1) sum += source[index(position) + channel] ?? 0;
        for (let position = 0; position < length; position += 1) {
          this.pixels[index(position) + channel] = Math.round(sum / window);
          sum += (source[index(position + radius + 1) + channel] ?? 0) - (source[index(position - radius) + channel] ?? 0);
        }
      }
    }
  }

  /** Adds seeded Gaussian grain in `block` × `block` cells, the same on the three channels (a coarse grain keeps the PNG small). */
  noise(rng: Rng, amplitude: number, block = 6): void {
    for (let by = 0; by < this.height; by += block) {
      for (let bx = 0; bx < this.width; bx += block) {
        const delta = Math.round(rng.normal() * amplitude);
        for (let y = by; y < Math.min(this.height, by + block); y += 1) {
          for (let x = bx; x < Math.min(this.width, bx + block); x += 1) {
            const at = (y * this.width + x) * 3;
            for (let channel = 0; channel < 3; channel += 1) this.pixels[at + channel] = Math.min(255, Math.max(0, (this.pixels[at + channel] ?? 0) + delta));
          }
        }
      }
    }
  }
}

/** Sizes of the three box blurs that approximate a Gaussian of `sigma` (odd sizes). */
function boxSizes(sigma: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  return [0, 1, 2].map((index) => (index < m ? lower : upper));
}
