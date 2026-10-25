// FL-099 · isolation between worlds, against the local UI server (tests/ui-server): the real `appRouter`
// over an in-process seed with two guest worlds of the same template (`g03` and `g04`, the same personas
// and the same timers) and sessions signed by this run's key, verified by the BFF's real verifier. A
// guest of g03 who names g04 gets 403 `CROSS_WORLD` and nothing of it; what a guest of g04 does on its
// phone and its clock never shows in g03. When the runner did not start a UI server (`E2E_UI_SERVER_URL`),
// this file starts its own on a free port and stops it at the end. Nothing leaves the machine.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { ensureRunKeys, runIssuer, sessionTokens, staffClaims, type StoredTokens } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { clockCopy } from "../src/views/clock/copy.ts";
import { simulatorCopy } from "../src/views/simulator/copy.ts";
import { FAKE_COGNITO } from "./support/env";
import { TOKENS_KEY } from "./support/session";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const OWN_PORT = 4191;

test.describe.configure({ mode: "serial" });

let server: ChildProcess | undefined;
let base = process.env.E2E_UI_SERVER_URL ?? "";

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the UI server did not answer at ${url}`);
}

test.beforeAll(async () => {
  test.setTimeout(150_000);
  if (base !== "") return;
  const keys = ensureRunKeys();
  base = `http://127.0.0.1:${OWN_PORT}`;
  server = spawn("npx", ["tsx", "tests/ui-server/main.ts"], {
    cwd: REPO,
    env: { ...process.env, ...FAKE_COGNITO, E2E_UI_SERVER_PORT: String(OWN_PORT), E2E_JWKS: keys.jwksJson, E2E_SIGNING_KEY: "" },
    stdio: "ignore",
  });
  await waitFor(`${base}/login`, 120_000);
});

test.afterAll(() => {
  server?.kill();
});

function guestOf(worldId: "g03" | "g04"): StoredTokens {
  return sessionTokens(staffClaims(worldId, "GUEST"), runIssuer());
}

async function plant(page: Page, tokens: StoredTokens): Promise<void> {
  await page.addInitScript(({ key, value }) => window.sessionStorage.setItem(key, value), { key: TOKENS_KEY, value: JSON.stringify(tokens) });
}

async function query(request: APIRequestContext, tokens: StoredTokens, path: string, input: unknown) {
  const response = await request.get(`${base}/api/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { authorization: `Bearer ${tokens.idToken}` } });
  return { status: response.status(), body: await response.text() };
}

async function mutate(request: APIRequestContext, tokens: StoredTokens, path: string, input: unknown) {
  const response = await request.post(`${base}/api/${path}`, { headers: { authorization: `Bearer ${tokens.idToken}`, "content-type": "application/json" }, data: input });
  return { status: response.status(), body: await response.text() };
}

test.describe("isolation between worlds [FL-099]", () => {
  test("[FL-099] a guest of g03 who names g04 gets 403 CROSS_WORLD and nothing of it; the same question for g03 is answered", async ({ request }) => {
    const g03 = guestOf("g03");
    for (const [path, input] of [
      ["complaints.get", { worldId: "g04", complaintId: "cmp-h000120" }],
      ["customers.get", { worldId: "g04", customerId: "cus-0001" }],
    ] as const) {
      const answer = await query(request, g03, path, input);
      expect(answer.status, path).toBe(403);
      expect(answer.body, path).toContain('"reason":"CROSS_WORLD"');
      expect(answer.body, path).not.toContain('"result"');
    }
    const own = await query(request, g03, "complaints.get", { complaintId: "cmp-h000120" });
    expect(own.status).toBe(200);
  });

  test("[FL-099] a message from a persona's phone in g04 and a move of g04's clock never reach g03", async ({ page, request }) => {
    const g04 = guestOf("g04");
    const text = "Pagué la cuota 4 en la Red de cobro Norte el martes a la tarde y me sigue figurando atrasada";
    expect((await mutate(request, g04, "simulator.sendText", { persona: "C01", text })).status).toBe(200);
    // The UI server runs the queued turn when asked (as the stage's worker would): until then the world
    // is busy and the clock answers 409 WORLD_BUSY.
    await request.post(`${base}/__e2e/settle`);
    expect((await mutate(request, g04, "clock.advance", { minutes: 60 })).status).toBe(200);
    const theirs = JSON.parse((await query(request, g04, "simulator.threads", { persona: "C01" })).body) as { result: { data: { messages: { body?: string }[] } } };
    expect(theirs.result.data.messages.some((message) => message.body === text)).toBe(true);

    await plant(page, guestOf("g03"));
    await page.goto(`${base}/app/simulator`);
    await expect(page.getByText(`${copy.app.worldLabel}: g03`)).toBeVisible();
    const phone = page.getByRole("region", { name: simulatorCopy.phone.title("Valeria Quiroga") });
    await expect(phone.getByText(simulatorCopy.phone.empty)).toBeVisible();
    await expect(phone.getByText(text, { exact: true })).toHaveCount(0);

    await page.goto(`${base}/app/clock`);
    await expect(page.locator("#clock-now").getByText("mié 07/10 10:10")).toBeVisible();
    await expect(page.locator("#clock-now").getByText(clockCopy.now.paused)).toBeVisible();
  });
});
