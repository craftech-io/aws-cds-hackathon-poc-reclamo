// Texts of the public landing in Spanish (Argentina) and English with a switch (docs/landing-spec.md
// §2). Both languages carry the same keys (landing.test.ts); each lives in its own file.
import { en } from "./copy-en";
import { es, type LandingCopy } from "./copy-es";

export type { LandingCopy };

export const LANDING_COPY = { es, en } as const satisfies Readonly<Record<string, LandingCopy>>;

export type LandingLang = keyof typeof LANDING_COPY;
