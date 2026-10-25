// Media of the landing, described by public/landing/manifest.json (manifest.ts, docs/landing-spec.md §7):
// the real console captures of the pipeline (scripts/landing/), the renders that wait for one, the
// video, the public architecture diagram and the measured batch, all swappable without touching code.
// Read once per visit and parsed with zod; if it cannot be read the landing shows the renders and no
// pictures.
import { useEffect, useState } from "react";
import { fetchWithRetry } from "../../lib/http";
import type { LandingLang } from "./copy";
import { type CaptureItem, LandingManifest, type Picture } from "./manifest";

export const MANIFEST_URL = "/landing/manifest.json";

export type MediaState = { readonly status: "loading" } | { readonly status: "ready"; readonly manifest: LandingManifest } | { readonly status: "unavailable" };

let cached: Promise<LandingManifest> | undefined;

function loadManifest(): Promise<LandingManifest> {
  cached ??= fetchWithRetry(MANIFEST_URL, { headers: { accept: "application/json" } }, { attempts: 2, timeoutMs: 8_000 })
    .then(async (response) => {
      if (!response.ok) throw new Error(`manifest answered ${response.status}`);
      return LandingManifest.parse(await response.json());
    })
    .catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  return cached;
}

export function useLandingMedia(): MediaState {
  const [state, setState] = useState<MediaState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    loadManifest().then(
      (manifest) => active && setState({ status: "ready", manifest }),
      () => active && setState({ status: "unavailable" }),
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

export function manifestOf(state: MediaState): LandingManifest | undefined {
  return state.status === "ready" ? state.manifest : undefined;
}

/** The real capture of `id`, or `undefined` while it is still a render, a placeholder or unknown. */
export function captureOf(state: MediaState, id: string): CaptureItem | undefined {
  const item = manifestOf(state)?.media[id];
  return item?.status === "capture" ? item : undefined;
}

/** A picture of the manifest with its alternative text in the page's language: what a figure and the
 * zoom viewer draw. `mobile` is the phone-sized capture, served below 1024 px when there is one. */
export interface GalleryItem {
  readonly id: string;
  readonly desktop: Picture;
  readonly mobile?: Picture;
  readonly alt: string;
}

export function galleryItemOf(id: string, item: CaptureItem, lang: LandingLang): GalleryItem {
  return { id, desktop: item.desktop, ...(item.mobile ? { mobile: item.mobile } : {}), alt: item.alt[lang] };
}

/** The gallery shows real captures only, and only once there are at least this many (§7). */
export const GALLERY_MIN_CAPTURES = 4;

/** Every real capture in manifest order: what the zoom viewer walks through. */
export function captureItems(state: MediaState, lang: LandingLang): GalleryItem[] {
  const media = manifestOf(state)?.media ?? {};
  return Object.entries(media).flatMap(([id, item]) => (item.status === "capture" ? [galleryItemOf(id, item, lang)] : []));
}

export const ARCHITECTURE_ID = "architecture";

/** The public architecture diagram in the page's language, once rendered (`npm run diagram:render`). */
export function architectureItem(state: MediaState, lang: LandingLang): GalleryItem | undefined {
  const architecture = manifestOf(state)?.architecture;
  return architecture ? { id: ARCHITECTURE_ID, desktop: architecture[lang], alt: architecture.alt[lang] } : undefined;
}

/** What the zoom viewer walks through: every real capture, then the diagram. */
export function zoomItems(state: MediaState, lang: LandingLang): GalleryItem[] {
  const diagram = architectureItem(state, lang);
  return [...captureItems(state, lang), ...(diagram ? [diagram] : [])];
}

/** The captures of the gallery section; empty (the section hides) below the minimum. */
export function galleryItems(state: MediaState, lang: LandingLang): GalleryItem[] {
  const captures = captureItems(state, lang);
  return captures.length >= GALLERY_MIN_CAPTURES ? captures : [];
}
