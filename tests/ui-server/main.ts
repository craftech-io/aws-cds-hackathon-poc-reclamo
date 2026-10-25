// Entry of the local UI server that Playwright starts (packages/web/e2e/playwright.config.ts): Vite serves
// the console in middleware mode and the back half (app.ts) answers `/api`, `/s3` and `/__e2e` on the
// same origin, as the Router does in the stage. Configuration comes from the runner, never from a real
// pool: the port (`E2E_UI_SERVER_PORT`), the run's public keys (`E2E_JWKS`, run-keys.ts) and the
// placeholder pool of the build (`VITE_COGNITO_*`, read by Vite). When tests/ui-server/guest-signup.ts
// exists, its `guestSignupServices` wires the self-signup. It listens on 127.0.0.1 only.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";
import { type PublicServicesFactory, createUiApp } from "./app";
import { runJwksFromEnv } from "./run-keys";

const DEFAULT_PORT = 4180;
const GUEST_SIGNUP = fileURLToPath(new URL("./guest-signup.ts", import.meta.url));

/** The self-signup wiring when its module exists (its own work package writes it). */
async function publicServices(): Promise<PublicServicesFactory | undefined> {
  if (!existsSync(GUEST_SIGNUP)) return undefined;
  const module = (await import(pathToFileURL(GUEST_SIGNUP).href)) as { guestSignupServices?: PublicServicesFactory };
  return module.guestSignupServices;
}

async function main(): Promise<void> {
  const port = Number(process.env.E2E_UI_SERVER_PORT ?? DEFAULT_PORT);
  const origin = `http://127.0.0.1:${port}`;
  const signup = await publicServices();
  const app = await createUiApp({ origin, jwks: runJwksFromEnv(), ...(signup === undefined ? {} : { publicServices: signup }) });
  const web = fileURLToPath(new URL("../../packages/web", import.meta.url));
  const vite = await createViteServer({ root: web, configFile: `${web}/vite.config.ts`, server: { middlewareMode: true, hmr: false }, appType: "spa" });
  const server = createServer((request, response) => {
    app
      .handle(request, response)
      .then((handled) => {
        if (!handled) vite.middlewares(request, response);
      })
      .catch((error: unknown) => {
        process.stderr.write(`ui-server: ${error instanceof Error ? error.name : "error"} on ${request.method ?? "?"} ${new URL(request.url ?? "/", origin).pathname}\n`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`ui-server: ${origin}\n`));
}

void main();
