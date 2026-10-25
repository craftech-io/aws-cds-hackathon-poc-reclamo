// The landing's media manifest, public/landing/manifest.json (docs/landing-spec.md §7), as a schema with
// no DOM and no React, so the capture pipeline (scripts/landing/) and the diagram renderer
// (scripts/diagram/) write exactly what the page reads. Each entry of `media` is one of:
//   capture      a real capture of the console (scripts/landing/capture-console.ts): the desktop picture
//                and, when taken, the mobile one, each as AVIF and WebP at 1x and 2x plus a PNG fallback,
//                with where and when it was taken
//   render       a real React component drawn with synthetic data, until its capture exists: `component`
//                names what draws it, `replacedBy` the capture that replaces it and `due` the planned date
//   placeholder  a console capture that does not exist yet, never shown publicly, with its planned date
// The manifest also names the product video (`null` hides its section), the public architecture
// diagram in both languages (`npm run diagram:render`) and the measured batch of the impact section.
import { z } from "zod";

export const MANIFEST_VERSION = 2;

const LandingFile = z.string().regex(/^\/landing\/[a-z0-9][a-z0-9/._@-]*$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Alt = z.object({ es: z.string().min(1), en: z.string().min(1) }).strict();
export type Alt = z.infer<typeof Alt>;

/** The two viewports a console capture is taken in (CSS pixels; the pictures are 2x). */
export const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const;
export type Viewport = keyof typeof VIEWPORTS;

const Source = z.object({ src: LandingFile, w: z.number().int().positive() }).strict();
export type Source = z.infer<typeof Source>;

/** One picture: its intrinsic size (the largest source), AVIF and WebP by width, and the PNG fallback. */
export const Picture = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    avif: z.array(Source),
    webp: z.array(Source).min(1),
    png: LandingFile,
  })
  .strict();
export type Picture = z.infer<typeof Picture>;

/** The components a render is drawn with (docs/landing-spec.md §7). */
export const RenderComponent = z.enum(["PhoneFrame", "EvidenceCard", "EmailFrame", "TapeRow", "RuleChip", "StatTile"]);
export type RenderComponent = z.infer<typeof RenderComponent>;

const RenderItem = z.object({ status: z.literal("render"), component: RenderComponent, replacedBy: z.string().min(1), due: Day }).strict();

const PlaceholderItem = z
  .object({ status: z.literal("placeholder"), file: LandingFile, width: z.number().int().positive(), height: z.number().int().positive(), alt: Alt, due: Day })
  .strict();

const CaptureItem = z
  .object({
    status: z.literal("capture"),
    desktop: Picture,
    mobile: Picture.optional(),
    alt: Alt,
    /** Where it was taken: the local console over the deterministic guest world. */
    origin: z.literal("local"),
    capturedAt: Day,
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  })
  .strict();

export const MediaItem = z.discriminatedUnion("status", [RenderItem, PlaceholderItem, CaptureItem]);
export type MediaItem = z.infer<typeof MediaItem>;
export type CaptureItem = z.infer<typeof CaptureItem>;

const Video = z.object({ src: LandingFile, poster: LandingFile, type: z.literal("video/mp4") }).strict();

const Architecture = z.object({ es: Picture, en: Picture, alt: Alt, renderedAt: Day }).strict();
export type Architecture = z.infer<typeof Architecture>;

const Measured = z
  .object({
    n: z.number().int().positive(),
    ranOn: Day,
    figures: z.object({ timeToNumber: z.string().min(1), resolvedAlone: z.string().min(1), answeredOnTime: z.string().min(1), violations: z.string().min(1) }).strict(),
  })
  .strict();
export type Measured = z.infer<typeof Measured>;

export const LandingManifest = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    /** The product video; `null` hides the section and the hero's third call to action. */
    video: Video.nullable(),
    /** The public architecture diagram rendered by `npm run diagram:render`. */
    architecture: Architecture.nullable(),
    /** The batch run with the real agent (WP-46/WP-49); `null` shows targets only. */
    measured: Measured.nullable(),
    media: z.record(z.string().regex(/^[a-z0-9-]+$/), MediaItem),
  })
  .strict();
export type LandingManifest = z.infer<typeof LandingManifest>;

/** The address of one encoded file of a picture: `/landing/<id>/<variant>[-<width>].<ext>`. */
export function pictureSrc(id: string, variant: string, ext: "avif" | "webp" | "png", width?: number): string {
  return `/landing/${id}/${variant}${width === undefined ? "" : `-${width}`}.${ext}`;
}

/** The manifest with `entry` recorded under `id` (a new capture or a new version of one), order kept. */
export function withMedia(manifest: LandingManifest, id: string, entry: MediaItem): LandingManifest {
  return { ...manifest, media: { ...manifest.media, [id]: entry } };
}

/** Every file a manifest serves, video and diagram included: what must exist under public/ (a placeholder's
 * planned file does not exist yet and is never served). */
export function manifestFiles(manifest: LandingManifest): string[] {
  const of = (picture: Picture) => [...picture.avif.map((source) => source.src), ...picture.webp.map((source) => source.src), picture.png];
  const media = Object.values(manifest.media).flatMap((item) => (item.status === "capture" ? [...of(item.desktop), ...(item.mobile ? of(item.mobile) : [])] : []));
  const video = manifest.video ? [manifest.video.src, manifest.video.poster] : [];
  const diagram = manifest.architecture ? [...of(manifest.architecture.es), ...of(manifest.architecture.en)] : [];
  return [...media, ...video, ...diagram];
}
