// Playwright against the DEPLOYED stage (https://reclamo.demo.craftech.io): the public surfaces as a
// visitor sees them (docs/landing-spec.md §10, docs/test-plan.md §3), in an installed Google Chrome at
// 390 × 844 and 1440 × 900. Separate from `npm run test:ui` (whose config ignores `poc/**`): these
// specs need the network and the stage, never a local server.
//
//   npm run test:poc                         landing, /signup, /login, recovery and legal pages
//   POC_QA_SIGNUP=1 npx sst shell --stage poc -- npx playwright test -c packages/web/e2e/poc/playwright.config.ts guest
//                                            + the QA self-signup through the QaDriver (synthetic
//                                              success+qa-…@simulator.amazonses.com only), its world,
//                                              the console, sign-out and the QA lead
//
// POC_EVIDENCE_DIR (outside the repository) receives the full-page screenshots and the redacted
// test-lead.json; without it they go under the run's output directory. POC_SITE moves the target.
// Traces record request bodies: off unless E2E_TRACE=1.
import { defineConfig } from "@playwright/test";
import { OUTPUT_DIR, SITE, VIEWPORTS } from "./support/site";

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  outputDir: `${OUTPUT_DIR}/results`,
  fullyParallel: false,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: SITE,
    channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome",
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    deviceScaleFactor: 1,
    trace: process.env.E2E_TRACE === "1" ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    navigationTimeout: 60_000,
  },
  projects: [
    { name: "phone", use: { viewport: VIEWPORTS.phone, hasTouch: true, isMobile: true } },
    { name: "desktop", use: { viewport: VIEWPORTS.desktop } },
  ],
});
