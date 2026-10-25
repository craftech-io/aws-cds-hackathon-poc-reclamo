// FL-117, FL-120, FL-121 and FL-124 · the screens a self-signup guest goes through after confirming the
// code, one screenshot each in es/en at 390x844 and 1440x900 (docs/landing-spec.md §9.4, §9.5): the world
// registered without a queue, in line with its position, being built, past the 600 s "taking longer"
// threshold, expired with "Set up my environment", and the first console screen at READY. The BFF is
// page.route with the exact `guest.status` of each state; the screenshots go to the run's output
// directory (`E2E_OUTPUT_DIR`) for the design review of the signup funnel.
import { type Page, expect, test } from "@playwright/test";
import { findNeutralTerms } from "../../../scripts/lint/neutral-surfaces.ts";
import { copy } from "../src/copy/console.ts";
import { TOKENS_KEY } from "../src/lib/auth/tokens.ts";
import { type SelfSignupClaims, selfSignupTokens, simulatorEmail, simulatorWorld } from "../src/lib/auth/testing/guest-e2e.ts";
import type { RouterOutputs } from "../src/lib/trpc-router.ts";
import { AUTH_COPY } from "../src/views/login/auth-copy.ts";
import { type ApiAnswer, NOT_IMPLEMENTED, routeApi } from "./support/api-route";

type Lang = keyof typeof AUTH_COPY;
type State = "registered" | "queued" | "creating" | "slow" | "expired" | "inbox";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
const SIM_NOW = "2026-10-07T13:30:00.000Z";
const FIRST_COMPLAINT: RouterOutputs["inbox"]["list"]["items"][number] = {
  complaintId: "cmp-c01",
  complaintNumber: "R-2026-000123",
  kind: "RECLAMO",
  type: "PAYMENT_NOT_REFLECTED",
  status: "AWAITING_SETTLEMENT",
  priority: "NORMAL",
  control: "AGENT",
  origin: "LIVE",
  customerId: "cus-c01",
  summary: "Pagó la cuota 4 en la Red de cobro Norte y no se refleja.",
  filedAtSim: "2026-10-07T13:12:00.000Z",
  deadlineSim: "2026-10-23T02:59:59.000Z",
  deadlineText: "jueves 22/10",
  businessDaysLeft: 10,
  slaState: "ON_TIME",
  nextMilestone: null,
  blockedBy: "NETWORK",
  openTasks: 0,
  handoffReason: null,
  pinned: true,
};

const WORLD_STATUS: Readonly<Record<State, { readonly worldStatus: string; readonly queuePosition: number }>> = {
  registered: { worldStatus: "REGISTERED", queuePosition: 0 },
  queued: { worldStatus: "REGISTERED", queuePosition: 3 },
  creating: { worldStatus: "CREATING", queuePosition: 0 },
  slow: { worldStatus: "REGISTERED", queuePosition: 0 },
  expired: { worldStatus: "EXPIRED", queuePosition: 0 },
  inbox: { worldStatus: "READY", queuePosition: 0 },
};

function answer(state: State, path: string): ApiAnswer {
  if (path === "guest.status") return { data: WORLD_STATUS[state] };
  if (path === "inbox.list") return { data: { simNow: SIM_NOW, total: 1, items: [FIRST_COMPLAINT] } };
  if (path === "clock.get") return { data: { mode: "PAUSED", simNow: SIM_NOW } };
  return NOT_IMPLEMENTED;
}

async function plantGuest(page: Page, worldStatus: string): Promise<void> {
  const claims: SelfSignupClaims = { email: simulatorEmail("su1"), worldId: simulatorWorld("su1"), worldStatus };
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(selfSignupTokens(claims)) },
  );
}

/** What each state must say, in the page's language. */
function expected(state: State, lang: Lang): string {
  const text = AUTH_COPY[lang].provisioning;
  const byState: Record<State, string> = {
    registered: text.preparingLead,
    queued: `${text.queued.before}3${text.queued.after}`,
    creating: text.creating,
    slow: text.slow,
    expired: text.expiredButton,
    inbox: copy.views.inbox.title,
  };
  return byState[state];
}

for (const viewport of VIEWPORTS) {
  for (const lang of ["es", "en"] as const) {
    test.describe(`the guest's funnel after the code, ${lang} at ${viewport.width}x${viewport.height} [FL-117] [FL-120] [FL-121] [FL-124]`, () => {
      test.use({ viewport });
      for (const state of Object.keys(WORLD_STATUS) as State[]) {
        test(`[FL-120] ${state}: the fixed screen of the state, neutral and without horizontal scroll`, async ({ page }, info) => {
          if (state === "slow") await page.clock.install();
          await routeApi(page, (path) => answer(state, path));
          await plantGuest(page, WORLD_STATUS[state].worldStatus);
          await page.goto(`${state === "inbox" ? "/app/inbox" : "/signup/provisioning"}${lang === "en" ? "?lang=en" : ""}`);
          if (state === "slow") {
            await expect(page.getByText(AUTH_COPY[lang].provisioning.preparingLead)).toBeVisible();
            await page.clock.fastForward("10:01");
          }
          const shown = state === "inbox" ? page.getByRole("heading", { name: expected(state, lang) }) : page.getByText(expected(state, lang)).first();
          await expect(shown).toBeVisible({ timeout: 10_000 });
          const text = await page.locator("body").innerText();
          expect(text).not.toMatch(/Cognito|NotAuthorized|Exception/);
          expect(findNeutralTerms(`provisioning-${state}`, text)).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const name = `${state === "inbox" ? "console-inbox-guest" : `provisioning-${state}`}-${lang}-${viewport.width}x${viewport.height}`;
          await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: "disabled" });
        });
      }
    });
  }
}
