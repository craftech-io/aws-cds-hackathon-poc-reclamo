// `/`: the commercial landing of Reclamo en regla (docs/landing-spec.md, ADR-0019, ADR-0021), in
// Spanish or English. No login: it tells what the product solves, walks one complaint end to end with
// real captures of the console (a render of its real components for a step without one), says what is real
// and what is simulated, and sends the visitor to `/signup`, `/login` or Craftech's contact form. The
// sections render from the manifest and a small environment (signed in or not, the address), so the
// unit tests draw the same page without the session or the router.
import { useEffect, useRef } from "react";
import { useSession } from "../../context/SessionContext";
import { useRouter } from "../../lib/router";
import { captureAttribution } from "./attribution";
import { ClosingSection, Footer } from "./Closing";
import { LandingEnvProvider, type LandingEnv } from "./cta";
import { GalleryProvider } from "./gallery";
import { Header } from "./Header";
import { Hero } from "./Hero";
import { ImpactSection } from "./ImpactSection";
import { IntegrationSection, SimulatedSection, VideoSection } from "./IntegrationSections";
import { LandingLangProvider, langFromSearch } from "./lang";
import { manifestOf, useLandingMedia, type MediaState } from "./media";
import { useReducedMotion, useReveal } from "./motion/hooks";
import { ActorsSection, ProblemSection, RulesSection } from "./Sections";
import { ProductTour } from "./tour/ProductTour";

/** The whole page for a manifest state: what LandingView mounts and what the unit tests render. */
export function LandingPage({ media }: { readonly media: MediaState }) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useReveal(root, !reduced);
  const manifest = manifestOf(media);
  const video = manifest?.video ?? null;
  return (
    <GalleryProvider media={media}>
      <div ref={root} className="min-h-screen bg-paper">
        <Header />
        <main id="contenido" tabIndex={-1} className="outline-none">
          <Hero hasVideo={video !== null} />
          <ProblemSection />
          <ProductTour media={media} />
          <ActorsSection />
          <RulesSection />
          <ImpactSection measured={manifest?.measured ?? null} />
          {video ? <VideoSection video={video} /> : null}
          <IntegrationSection media={media} />
          <SimulatedSection media={media} />
          <ClosingSection />
        </main>
        <Footer />
      </div>
    </GalleryProvider>
  );
}

export function LandingView() {
  const { search, navigate } = useRouter();
  const { state } = useSession();
  const media = useLandingMedia();
  useEffect(() => {
    captureAttribution();
  }, []);
  const env: LandingEnv = { signedIn: state.status === "authenticated", search, navigate };
  return (
    <LandingEnvProvider value={env}>
      <LandingLangProvider initial={langFromSearch(search)}>
        <LandingPage media={media} />
      </LandingLangProvider>
    </LandingEnvProvider>
  );
}
