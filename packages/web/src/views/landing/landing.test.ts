// FL-102 · the commercial landing and its legal pages (docs/landing-spec.md, ADR-0019, ADR-0021): the
// copy in both languages, where each call to action goes, the page as it renders (section order, the
// real console captures of the tour as AVIF/WebP pictures with `srcset`, the renders that stand in for a
// missing capture with the simulated-WhatsApp label and the English gloss, the video in its two
// variants, the public diagram, the gallery's minimum, the targets' labels), the captures manifest
// (every entry captured, every file on disk) and the content the privacy policy and the terms must
// carry. FL-128: no contest word on any of it.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONSOLE_TOKENS_KEY } from "../../../../../scripts/landing/console-session";
import { findNeutralTerms } from "../../../../../scripts/lint/neutral-surfaces";
import { TOKENS_KEY } from "../../lib/auth/tokens";
import { LANDING_COPY, type LandingLang } from "./copy";
import { LandingEnvProvider } from "./cta";
import { GOAL_KEYS, countsUp } from "./goals";
import { LandingLangProvider, langFromSearch, searchWithLang } from "./lang";
import { LandingPage } from "./LandingView";
import { CONTACT_PLACEMENTS, SIGNUP_PATH, contactHref, loginHref, signupHref } from "./links";
import { type CaptureItem, LandingManifest, type MediaItem, type Picture, manifestFiles } from "./manifest";
import { GALLERY_MIN_CAPTURES, galleryItems, type MediaState } from "./media";
import { CUSTOMER_MESSAGE } from "./tour/main-story";
import { TOUR_STEPS } from "./tour/tour-steps";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));
/** The step whose visual stays a render of the targets until a measured batch exists. */
const METRICS = "tour-07-metrics";
/** The tour's phone steps, cropped to the phone and the step's one bubble. */
const PHONE_CROPS = ["tour-01-whatsapp", "tour-02-ack"];
const CAPTURED = TOUR_STEPS.filter((step) => step.mediaId !== METRICS);
const manifest = LandingManifest.parse(JSON.parse(readFileSync(`${PUBLIC_DIR}/landing/manifest.json`, "utf8")));

/** Every key path of an object, functions included as leaves. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

function render(lang: LandingLang, state: MediaState = { status: "ready", manifest }, search = ""): string {
  const page = createElement(LandingPage, { media: state });
  const withLang = createElement(LandingLangProvider, { initial: lang, children: page });
  return renderToStaticMarkup(createElement(LandingEnvProvider, { value: { signedIn: false, search: new URLSearchParams(search) }, children: withLang }));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

function ids(html: string): string[] {
  return [...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1] ?? "");
}

function hrefs(html: string, cta: string): string[] {
  return [...html.matchAll(new RegExp(`<a href="([^"]+)"[^>]*data-cta="${cta}"`, "g"))].map((match) => (match[1] ?? "").replaceAll("&amp;", "&"));
}

function srcset(picture: Picture | undefined, format: "avif" | "webp"): string {
  return (picture?.[format] ?? []).map((source) => `${source.src} ${source.w}w`).join(", ");
}

/** The same manifest before the pipeline: each tour step a render, each gallery picture a placeholder. */
const beforeCaptures: LandingManifest = {
  ...manifest,
  architecture: null,
  media: Object.fromEntries(
    Object.keys(manifest.media).map((id): [string, MediaItem] =>
      id.startsWith("tour-")
        ? [id, { status: "render", component: "PhoneFrame", replacedBy: id, due: "2026-10-16" }]
        : [id, { status: "placeholder", file: `/landing/${id}@2x.avif`, width: 2560, height: 1600, alt: { es: id, en: id }, due: "2026-10-16" }],
    ),
  ),
};
const renders: MediaState = { status: "ready", manifest: beforeCaptures };

function captureFixture(index: number): CaptureItem {
  const picture = { width: 1200, height: 400, avif: [], webp: [{ src: `/landing/c-${index}/desktop-600.webp`, w: 600 }], png: `/landing/c-${index}/desktop.png` };
  return { status: "capture", desktop: picture, alt: { es: `Captura ${index}`, en: `Capture ${index}` }, origin: "local", capturedAt: "2026-10-09", commit: "abcdef1" };
}

const withVideo: MediaState = { status: "ready", manifest: { ...manifest, video: { src: "/landing/video/reclamo-en-regla.mp4", poster: "/landing/video/poster.jpg", type: "video/mp4" } } };

describe("landing copy [FL-102]", () => {
  it("has the same keys in Spanish and English", () => {
    expect(keyPaths(LANDING_COPY.en)).toEqual(keyPaths(LANDING_COPY.es));
  });

  it("carries the final copy of the spec and the single product call to action of ADR-0021", () => {
    expect(LANDING_COPY.es.hero.title).toBe("Cada reclamo, con número en el acto, investigado y respondido por escrito a tiempo.");
    expect(LANDING_COPY.en.hero.title).toBe("Every complaint, numbered on the spot, investigated and answered in writing on time.");
    expect(LANDING_COPY.es.cta.try).toBe("Probar Reclamo en regla");
    expect(LANDING_COPY.en.cta.try).toBe("Try Reclamo en regla");
    expect(LANDING_COPY.es.cta.talk).toBe("Hablemos");
    expect(LANDING_COPY.es.hero.note).toMatch(/100 % sintéticos/);
    expect(LANDING_COPY.en.hero.note).toMatch(/100% synthetic/);
    expect(LANDING_COPY.es.problem.legalNote).toBe("Nuestra lectura de la normativa, no asesoramiento legal.");
    expect(Object.keys(LANDING_COPY.es.tour.steps)).toEqual(TOUR_STEPS.map((step) => step.id));
    for (const lang of ["es", "en"] as const) expect(JSON.stringify(LANDING_COPY[lang])).not.toMatch(/ped[ií] acceso|pedinos acceso|ask (us )?for access|mailto:/i);
  });

  it("opens in English only when the link asks for it, and the switch keeps every other parameter", () => {
    expect(langFromSearch(new URLSearchParams("lang=en"))).toBe("en");
    expect(langFromSearch(new URLSearchParams(""))).toBe("es");
    expect(langFromSearch(new URLSearchParams("lang=fr"))).toBe("es");
    expect(searchWithLang(new URLSearchParams("utm_source=news"), "en")).toBe("?utm_source=news&lang=en");
    expect(searchWithLang(new URLSearchParams("lang=en&utm_source=news"), "es")).toBe("?utm_source=news");
    expect(searchWithLang(new URLSearchParams("lang=en"), "es")).toBe("");
  });

  it("counts up only the intermediate targets: 0 and 100 % stay fixed", () => {
    const goals = LANDING_COPY.es.impact.goals;
    expect(GOAL_KEYS.filter((key) => countsUp(goals[key]))).toEqual(["timeToNumber", "resolvedAlone"]);
  });
});

describe("calls to action [FL-102]", () => {
  it("sends every 'Hablemos' to Craftech's contact form with the placement as utm_content", () => {
    expect(CONTACT_PLACEMENTS).toEqual(["header", "drawer", "hero", "closing", "footer", "signup-unavailable"]);
    for (const placement of CONTACT_PLACEMENTS) {
      expect(contactHref(placement)).toBe(`https://craftech.io/contact/?utm_source=reclamo-en-regla&utm_medium=demo&utm_campaign=poc-landing&utm_content=${placement}`);
    }
  });

  it("keeps the visit's valid utm_* parameters on the way to /signup and nothing else", () => {
    expect(signupHref(new URLSearchParams(""))).toBe(SIGNUP_PATH);
    expect(signupHref(new URLSearchParams("lang=en&utm_source=news&utm_campaign=launch-2026&ref=x"))).toBe("/signup?utm_source=news&utm_campaign=launch-2026");
    expect(signupHref(new URLSearchParams("utm_source=<script>&utm_medium=email"))).toBe("/signup?utm_medium=email");
    expect(signupHref(new URLSearchParams("utm_source=news"), "en")).toBe("/signup?lang=en&utm_source=news");
    expect(signupHref(new URLSearchParams(""), "en")).toBe("/signup?lang=en");
    expect(loginHref("en")).toBe("/login?lang=en");
    expect(loginHref("es")).toBe("/login");
  });

  it("renders 'Probar Reclamo en regla' as a full page load of /signup, 'Ingresar' to /login and each 'Hablemos' at its placement", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang, { status: "ready", manifest }, "utm_source=news");
      const tries = hrefs(html, "try");
      expect(tries.length).toBeGreaterThanOrEqual(3);
      // The access screens open in the landing's language.
      for (const href of tries) expect(href.replaceAll("&amp;", "&")).toBe(lang === "en" ? "/signup?lang=en&utm_source=news" : "/signup?utm_source=news");
      expect(hrefs(html, "sign-in").every((href) => href === (lang === "en" ? "/login?lang=en" : "/login"))).toBe(true);
      const talks = [...html.matchAll(/<a href="([^"]+)"[^>]*data-cta="talk" data-placement="([a-z-]+)"/g)].map((match) => [match[2], (match[1] ?? "").replaceAll("&amp;", "&")]);
      expect(talks.map(([placement]) => placement)).toEqual(["header", "hero", "closing", "footer"]);
      for (const [placement, href] of talks) expect(href).toBe(contactHref(placement as (typeof CONTACT_PLACEMENTS)[number]));
      expect(html).not.toContain("mailto:");
      expect(html).toContain('rel="noopener noreferrer"');
    }
  });
});

describe("landing page [FL-102] [FL-128]", () => {
  it("lays the sections out in the spec's order with one h1, and no video, diagram or gallery until they exist", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang, renders);
      expect(ids(html)).toEqual(["inicio", "problema", "recorrido", "que-hace", "reglas", "impacto", "integracion", "simulado", "empezar"]);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).not.toContain('href="#video"');
      expect(html).not.toContain("<video");
      expect(html).not.toContain('id="galeria"');
      expect(html).not.toContain('data-media="architecture"');
      expect(html).toContain('id="contenido"');
    }
  });

  it("puts the video before #integracion with controls, preload none, playsinline and a poster, never autoplay", () => {
    const html = render("es", withVideo);
    expect(ids(html)).toEqual(["inicio", "problema", "recorrido", "que-hace", "reglas", "impacto", "video", "integracion", "simulado", "empezar"]);
    const video = html.match(/<video[^>]*>/)?.[0] ?? "";
    expect(video).toMatch(/\bcontrols\b/);
    expect(video).toContain('preload="none"');
    expect(video).toMatch(/\bplaysinline\b/i);
    expect(video).toContain('poster="/landing/video/poster.jpg"');
    expect(video).not.toMatch(/autoplay/i);
    expect(html).toContain('href="#video"');
  });

  it("labels the phone 'WhatsApp (simulado)' and glosses every Spanish term of a render on the English page", () => {
    const es = text(render("es", renders));
    expect(es).toContain("WhatsApp (simulado)");
    expect(es).not.toContain("WhatsApp (simulated)");
    expect(es).not.toContain("business days");
    const en = text(render("en", renders));
    expect(en).toContain("WhatsApp (simulado) · WhatsApp (simulated)");
    expect(en).toContain("BLOQUEADO · BLOCKED");
    expect(en).toContain("Reencaminado · REROUTED");
    expect(en).toContain("On time · 10 business days");
  });

  it("draws a step whose capture is missing as a labelled render of real components, with the real customer copy", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang, renders);
      expect([...html.matchAll(/data-render="([^"]+)"/g)].map((match) => match[1])).toEqual(TOUR_STEPS.map((step) => step.mediaId));
      expect(html.split(LANDING_COPY[lang].tour.renderNote).length - 1).toBe(TOUR_STEPS.length);
      const plain = text(html);
      expect(plain).toContain("R-2026-000123");
      expect(plain).toContain("Soy el asistente automatizado de Jarilla (ficticio).");
      expect(plain).toContain("CH-WA-NO-COLLECTION");
      expect(plain).toContain("$ 118.640,00");
    }
  });

  it("shows each captured tour step as its real console capture: AVIF then WebP at 1x and 2x, the phone-sized one below 1024 px, labelled", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang);
      expect([...html.matchAll(/data-render="([^"]+)"/g)].map((match) => match[1])).toEqual([METRICS]);
      expect(html.split(LANDING_COPY[lang].tour.captureNote).length - 1).toBe(CAPTURED.length);
      for (const step of CAPTURED) {
        const item = manifest.media[step.mediaId] as CaptureItem;
        const figure = html.slice(html.indexOf(`<figure data-media="${step.mediaId}"`)).split("</figure>")[0] ?? "";
        expect(figure.indexOf(`type="image/avif" srcSet="${srcset(item.mobile, "avif")}"`), step.mediaId).toBeGreaterThan(0);
        expect(figure).toContain('media="(max-width: 1023px)"');
        expect(figure.indexOf(`srcSet="${srcset(item.desktop, "avif")}"`)).toBeLessThan(figure.indexOf(`srcSet="${srcset(item.desktop, "webp")}"`));
        expect(text(figure)).toContain(LANDING_COPY[lang].tour.captureNote);
        expect(figure).toContain(`<img src="${item.desktop.png}"`);
        expect(figure).toContain(`width="${item.desktop.width}" height="${item.desktop.height}" loading="lazy" decoding="async"`);
        expect(text(figure.match(/alt="([^"]*)"/)?.[1] ?? "")).toBe(item.alt[lang]);
      }
    }
  });

  it("shows the public architecture diagram in the page's language under #integracion, zoomable", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang);
      const integration = html.slice(html.indexOf('<section id="integracion"'), html.indexOf('<section id="simulado"'));
      expect(integration).toContain('data-media="architecture"');
      expect(integration).toContain(`/landing/architecture/${lang}-1920.avif 1920w, /landing/architecture/${lang}-3840.avif 3840w`);
      expect(text(integration)).toContain(LANDING_COPY[lang].integration.diagramCaption);
      expect(integration).toContain(`aria-label="${LANDING_COPY[lang].zoom.open}: `);
      expect(text(integration)).toContain(LANDING_COPY[lang].zoom.chip);
    }
  });

  it("shows a visible zoom chip on every zoomable capture of the tour", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang);
      const tour = html.slice(html.indexOf('<section id="recorrido"'), html.indexOf("</section>", html.indexOf('<section id="recorrido"')));
      const buttons = [...tour.matchAll(/<button[^>]*cursor-zoom-in[^>]*>([\s\S]*?)<\/button>/g)];
      expect(buttons.length).toBeGreaterThan(0);
      for (const [, inner] of buttons) expect(text(inner ?? "")).toContain(LANDING_COPY[lang].zoom.chip);
    }
  });

  it("labels every impact figure as a target", () => {
    for (const lang of ["es", "en"] as const) {
      const html = render(lang);
      const cards = [...html.matchAll(/data-goal="([a-zA-Z]+)"[^>]*>(.*?)<\/li>/g)];
      expect(cards.map((card) => card[1])).toEqual([...GOAL_KEYS]);
      for (const card of cards) expect(text(card[2] ?? "")).toContain(LANDING_COPY[lang].impact.target);
    }
  });

  it("shows the gallery only from four real captures, every capture as its desktop picture", () => {
    const media = (count: number): MediaState => ({ status: "ready", manifest: { ...beforeCaptures, media: { ...beforeCaptures.media, ...Object.fromEntries(Array.from({ length: count }, (_, index) => [`c-${index}`, captureFixture(index)])) } } });
    expect(galleryItems(media(GALLERY_MIN_CAPTURES - 1), "es")).toEqual([]);
    expect(galleryItems(media(GALLERY_MIN_CAPTURES), "en").map((item) => item.alt)).toEqual(["Capture 0", "Capture 1", "Capture 2", "Capture 3"]);
    expect(render("es", media(GALLERY_MIN_CAPTURES))).toContain('id="galeria"');
    expect(render("es", media(GALLERY_MIN_CAPTURES - 1))).not.toContain('id="galeria"');
    const html = render("en");
    const gallery = html.slice(html.indexOf('id="galeria"'));
    expect(gallery.match(/<figure data-media=/g)).toHaveLength(Object.values(manifest.media).filter((item) => item.status === "capture").length);
    expect(gallery).not.toContain("(max-width: 1023px)");
  });

  it("names no contest word and not the app's technical id, in either language [FL-128]", () => {
    for (const lang of ["es", "en"] as const) {
      expect(findNeutralTerms(`landing-${lang}`, text(render(lang, withVideo)))).toEqual([]);
      expect(findNeutralTerms(`landing-renders-${lang}`, text(render(lang, renders)))).toEqual([]);
    }
  });
});

describe("landing captures manifest [FL-102]", () => {
  it("replaced every render and placeholder of the plan with its real capture, taken locally, in both viewports for the tour, but the metrics", () => {
    const tour = TOUR_STEPS.map((step) => step.mediaId);
    expect(tour).toEqual(["tour-01-whatsapp", "tour-02-ack", "tour-03-evidence", "tour-04-email", "tour-05-blocked", "tour-06-register", "tour-07-metrics"]);
    expect(Object.keys(manifest.media)).toEqual([...tour, "gallery-console-inbox", "gallery-console-approvals"]);
    // Until a measured batch exists the metrics step is the render of the targets, each labelled "meta":
    // a capture of /app/metrics would lead the story's closing slide with "n/a".
    expect(manifest.measured).toBeNull();
    expect(manifest.media[METRICS]).toMatchObject({ status: "render", component: "StatTile", replacedBy: METRICS });
    for (const [id, item] of Object.entries(manifest.media)) {
      if (id === METRICS) continue;
      expect(item.status, id).toBe("capture");
      if (item.status !== "capture") continue;
      expect(item.origin).toBe("local");
      const widths = (picture: Picture) => picture.webp.map((source) => source.w);
      if (PHONE_CROPS.includes(id)) {
        // The phone only, down to the step's bubble: narrower and shorter than the viewport.
        expect(item.desktop.width, id).toBeLessThanOrEqual(2 * 448);
        expect(item.desktop.height, id).toBeLessThan(1600);
        expect(item.mobile?.width, id).toBeLessThan(780);
      } else if (tour.includes(id)) {
        // The step's block only, shot near the panel's 620 px (2x): drawn at about its own size, never a
        // full console squeezed into the panel, and short enough to stay inside the sticky panel.
        expect(item.desktop.width, id).toBeGreaterThanOrEqual(2 * 540);
        expect(item.desktop.width, id).toBeLessThanOrEqual(2 * 680);
        expect(item.desktop.height, id).toBeLessThanOrEqual(2 * 800);
        expect(item.mobile?.width, id).toBeLessThanOrEqual(2 * 360);
      } else {
        expect([item.desktop.width, item.desktop.height], id).toEqual([2560, 1600]);
      }
      expect(widths(item.desktop), id).toEqual([item.desktop.width / 2, item.desktop.width]);
      expect(item.desktop.avif.map((source) => source.w)).toEqual(widths(item.desktop));
      if (tour.includes(id)) expect(item.mobile && widths(item.mobile), id).toEqual([(item.mobile?.width ?? 0) / 2, item.mobile?.width]);
      else expect(item.mobile, id).toBeUndefined();
      expect(findNeutralTerms(id, `${item.alt.es}\n${item.alt.en}`)).toEqual([]);
    }
  });

  it("quotes in step 1 the very message its capture shows, in both languages", () => {
    expect(LANDING_COPY.es.tour.steps.whatsapp.text).toContain(`"${CUSTOMER_MESSAGE.es}."`);
    expect(LANDING_COPY.en.tour.steps.whatsapp.text).toContain(`"${CUSTOMER_MESSAGE.en}."`);
    for (const lang of ["es", "en"] as const) expect(LANDING_COPY[lang].tour.steps.whatsapp.text).not.toMatch(/se escribe solo|types itself/);
  });

  it("never claims more of the register than ADR-0014 does: an overwrite shows, it is not impossible", () => {
    for (const lang of ["es", "en"] as const) expect(JSON.stringify(LANDING_COPY[lang])).not.toMatch(/a prueba de (sobrescritura|alteraci)|inmutable|immutable|tamper-proof|cannot be altered/i);
  });

  it("dates any picture that is still provisional", () => {
    const provisional = { status: "render", component: "TapeRow", replacedBy: "tour-05-blocked" };
    expect(LandingManifest.safeParse({ ...manifest, media: { ...manifest.media, "tour-05-blocked": provisional } }).success).toBe(false);
    expect(LandingManifest.safeParse({ ...manifest, media: { ...manifest.media, "tour-05-blocked": { ...provisional, due: "2026-10-16" } } }).success).toBe(true);
  });

  it("plants the capture's session where the console reads it", () => {
    expect(CONSOLE_TOKENS_KEY).toBe(TOKENS_KEY);
  });

  it("names only files that exist: every capture, the diagram in both languages and, once delivered, the video", () => {
    expect(manifest.video).toBeNull();
    expect(manifest.architecture?.es.png).toBe("/landing/architecture/es.png");
    expect(manifest.architecture?.en.avif.map((source) => source.w)).toEqual([1920, 3840]);
    const files = manifestFiles(manifest);
    // 5 files a picture (2 AVIF, 2 WebP, a PNG): six tour captures in two viewports, two gallery views, the diagram in two languages.
    expect(files.length).toBe(6 * 2 * 5 + 2 * 5 + 2 * 5);
    for (const file of files) expect(existsSync(`${PUBLIC_DIR}${file}`), file).toBe(true);
  });
});

describe("legal pages [FL-102] [FL-128]", () => {
  const privacy = readFileSync(`${PUBLIC_DIR}/legal/privacy.html`, "utf8");
  const terms = readFileSync(`${PUBLIC_DIR}/legal/terms.html`, "utf8");

  it("names Craftech as controller with the rights mailbox, the contact form and the decided facts, in both languages", () => {
    const required = [
      "Craftech",
      "Ciudad Autónoma de Buenos Aires, Argentina",
      "sales@craftech.io",
      "https://craftech.io/contact/",
      "24 meses",
      "24 months",
      "Estados Unidos",
      "United States",
      "Ley 25.326",
      "Agencia de Acceso a la Información Pública",
      "2 días",
      "2 days",
      "consentimiento",
      "consent",
      "nuestra lectura, no asesoramiento legal",
      "our reading, not legal advice",
      'lang="es"',
      'lang="en"',
    ];
    for (const fact of required) expect(privacy, fact).toContain(fact);
    expect(privacy).toMatch(/arts?\. 14 a 16/);
    // What the register is, never more (ADR-0014): append-only and hash-chained, an overwrite detected.
    expect(privacy).toContain("de solo agregado, con cadena de hash");
    expect(privacy).toContain("append-only and hash-chained");
    expect(privacy).not.toMatch(/inmutable|immutable|a prueba de|tamper-proof/i);
  });

  it("invents nothing: no tax id, no street address, no 'to be confirmed' and no mailto", () => {
    for (const page of [privacy, terms]) {
      expect(page).not.toMatch(/CUIT|a confirmar|to be confirmed|mailto:/i);
      expect(findNeutralTerms("legal", text(page))).toEqual([]);
    }
  });

  it("says in the terms that it is a test environment of a product, without warranties and with usage limits", () => {
    for (const fact of ["entorno de prueba", "test environment", "sin garantías", "without warranties", "límites de uso", "usage limits", 'lang="en"']) expect(terms, fact).toContain(fact);
  });
});
