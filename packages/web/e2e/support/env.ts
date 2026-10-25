// Runner configuration of the console specs (test tooling on the operator's machine or CI, not a
// Lambda). Nothing here is a secret: specs run against a local Vite server with Cognito scripted by
// page.route and synthetic tokens; never real human credentials (docs/test-plan.md).
import { tmpdir } from "node:os";
import { join } from "node:path";

function portFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  const port = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error(`${name} must be a free TCP port`);
  return port;
}

/**
 * Local servers: a configured Vite build, one without Cognito variables, and the UI server of
 * tests/ui-server (the real `appRouter`). Each port can be moved (E2E_PORT, E2E_UNCONFIGURED_PORT,
 * E2E_UI_SERVER_PORT) so parallel runs on one machine do not stop each other's servers.
 */
export const PORTS = {
  console: portFrom("E2E_PORT", 4273),
  unconfigured: portFrom("E2E_UNCONFIGURED_PORT", 4274),
  ui: portFrom("E2E_UI_SERVER_PORT", 4280),
} as const;

/** Where the specs of the `console` project reach the UI server. */
export const UI_SERVER_URL = `http://127.0.0.1:${PORTS.ui}`;

export const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? join(tmpdir(), "reclamo-e2e");

/** Placeholders only: every Cognito call is answered by page.route (support/cognito-route.ts). */
export const FAKE_COGNITO = {
  VITE_COGNITO_USER_POOL_ID: "us-east-1_e2e",
  VITE_COGNITO_CLIENT_ID: "e2e-client",
} as const;
