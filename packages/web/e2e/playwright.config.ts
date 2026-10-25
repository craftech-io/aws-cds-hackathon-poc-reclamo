// Playwright for the console (docs/test-plan.md, level UI). Runs without AWS. Two projects:
//
//   shell     the login, landing, access screens and the views whose specs answer the BFF from the page
//             (support/api-route.ts) and script Cognito (support/cognito-route.ts): local Vite servers of
//             the console, one with placeholder Cognito variables and one without them.
//   console   the specs that need the real BFF (tape, register, emails, metrics, policy, roles,
//             isolation): the UI server of tests/ui-server (Vite + the real `appRouter` over an
//             in-process world), which verifies tokens with the real verifier against this run's JWKS.
//
//   npm run test:ui
//
// Sessions of the console project are signed with an ephemeral key created here for the run
// (tests/ui-server/run-keys.ts): the workers inherit the private half through the environment, the UI
// server gets only the JWKS. Browsers: the Chromium Playwright installs (`npx playwright install
// chromium`); E2E_BROWSER_CHANNEL=chrome uses an installed Google Chrome. Output (traces, screenshots)
// goes outside the repository.
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { JWKS_ENV, SIGNING_KEY_ENV, ensureRunKeys } from "../../../tests/ui-server/run-keys";
import { FAKE_COGNITO, OUTPUT_DIR, PORTS, UI_SERVER_URL } from "./support/env";

const keys = ensureRunKeys();
// isolation.spec.ts reaches this server instead of starting its own.
process.env.E2E_UI_SERVER_URL = UI_SERVER_URL;

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const CHANNEL = process.env.E2E_BROWSER_CHANNEL;
// Servers inherit the runner's environment; the private key stays with the runner and its workers.
const WITHOUT_PRIVATE_KEY = { [SIGNING_KEY_ENV]: "" };

/** The deployed stage's own suite (poc/playwright.config.ts, `npm run test:poc`): never part of this run. */
const DEPLOYED_SPECS = /(^|\/)poc\//;

/** Specs that run against the real BFF of the UI server. */
const CONSOLE_SPECS = /(^|\/)(tape|register|emails|metrics|policy|roles|isolation)\.spec\.ts$/;

function viteServer(port: number, env: Record<string, string>) {
  return {
    command: `npx vite --port ${port} --strictPort --host 127.0.0.1`,
    cwd: WEB_DIR,
    url: `http://127.0.0.1:${port}/login`,
    env: { ...env, ...WITHOUT_PRIVATE_KEY },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  };
}

const uiServer = {
  command: "npx tsx tests/ui-server/main.ts",
  cwd: REPO_DIR,
  url: `${UI_SERVER_URL}/login`,
  env: { ...FAKE_COGNITO, ...WITHOUT_PRIVATE_KEY, E2E_UI_SERVER_PORT: String(PORTS.ui), [JWKS_ENV]: keys.jwksJson },
  // A server of another run trusts another key: never reused.
  reuseExistingServer: false,
  timeout: 120_000,
};

export default defineConfig({
  testDir: ".",
  outputDir: OUTPUT_DIR,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    ...(CHANNEL !== undefined ? { channel: CHANNEL } : {}),
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    // Traces record request bodies: off unless asked for (E2E_TRACE=1).
    trace: process.env.E2E_TRACE === "1" ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "shell", testIgnore: [CONSOLE_SPECS, DEPLOYED_SPECS], use: { baseURL: `http://127.0.0.1:${PORTS.console}` } },
    { name: "console", testMatch: CONSOLE_SPECS, testIgnore: DEPLOYED_SPECS, use: { baseURL: UI_SERVER_URL } },
  ],
  webServer: [viteServer(PORTS.console, { ...FAKE_COGNITO }), viteServer(PORTS.unconfigured, {}), uiServer],
});
