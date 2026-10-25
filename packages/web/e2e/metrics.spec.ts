// FL-098 · metrics with N, source and label, on the UI server (tests/ui-server) with a signed session.
// The three tabs need runs a local world does not have (the 30-complaint batch with the real agent, the
// 300-complaint simulated load), so `metrics.summary` and `metrics.export` are answered by fixtures in
// the shape of packages/bff/src/metrics/kpis.ts; every other call of the page reaches the real BFF.
import { readFile } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";
import type { StaffRole } from "@reclamo/shared";
import { sessionTokens, staffClaims } from "../../../tests/ui-server/run-keys.ts";
import { copy } from "../src/copy/console.ts";
import { metricsCopy } from "../src/views/metrics/copy.ts";
import { TOKENS_KEY } from "./support/session";

async function signIn(page: Page, worldId: string, role: StaffRole): Promise<void> {
  const tokens = sessionTokens(staffClaims(worldId, role));
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem("reclamo.e2e.planted") !== null) return;
      window.sessionStorage.setItem("reclamo.e2e.planted", "1");
      window.sessionStorage.setItem(key, value);
    },
    { key: TOKENS_KEY, value: JSON.stringify(tokens) },
  );
}

/** Answers the procedures in `fixtures` (by their input) and lets the BFF answer the rest of a batch. */
async function answerWith(page: Page, fixtures: Readonly<Record<string, (input: { tab?: string } | undefined) => unknown>>): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/api\//, "")).split(",");
    if (!paths.some((path) => path in fixtures)) return route.fallback();
    const inputs = JSON.parse(url.searchParams.get("input") ?? "{}") as Record<string, { tab?: string } | undefined>;
    const others = paths.some((path) => !(path in fixtures)) ? ((await (await route.fetch()).json()) as unknown[]) : [];
    const answers = paths.map((path, index) => (path in fixtures ? { result: { data: fixtures[path]?.(inputs[String(index)]) } } : others[index]));
    await route.fulfill({ status: 200, contentType: "application/json", json: answers });
  });
}

const world = (ref: string) => ({ kind: "WORLD", ref });
const latency = { measuredUntil: "TRANSPORT_ACCEPTANCE_SIMULATED_WHATSAPP", coldStarts: { n: 2, p50: 6100, p95: 7200 } };
const TYPES = ["PAYMENT_NOT_REFLECTED", "PAYOFF_CERTIFICATE", "UNRECOGNIZED_CHARGE", "DUPLICATE_DEBIT", "TRANSFER_NOT_CREDITED", "DISBURSEMENT_NOT_RECEIVED", "UNKNOWN_OPERATION", "ACCOUNT_BLOCKED", "CLOSURE_OR_EARLY_PAYOFF", "DATA_CHANGE"];

const SUMMARIES: Readonly<Record<string, unknown>> = {
  WORLD: {
    tab: "WORLD",
    label: "MEASURED",
    source: world("demo"),
    n: 0,
    seededHistory: { total: 120, byStatus: { ANSWERED: 112, INVESTIGATING: 3, HUMAN_REVIEW: 5 }, byType: { PAYMENT_NOT_REFLECTED: 40, DATA_CHANGE: 80 }, answered: 112, answeredOnTime: 110, withDeliveryProof: 108, measuredN: 0 },
    kpis: [
      { key: "timeToNumberP50Ms", value: null, n: 0, source: world("demo"), label: "MEASURED", gap: "NO_DATA", detail: latency },
      { key: "resolvedWithoutHumanPct", value: null, n: 0, source: world("demo"), label: "MEASURED", gap: "NO_DATA" },
      { key: "policyViolations", value: 0, n: 0, source: { kind: "POLICY_AUDIT", ref: "demo" }, label: "MEASURED" },
      { key: "gateDecisions", value: 1, n: 19, source: { kind: "TAPE", ref: "demo" }, label: "MEASURED", detail: { byRule: [{ decision: "BLOCKED", ruleId: "CH-WA-NO-COLLECTION", senderClass: "OPERATOR", count: 1 }] } },
      { key: "costPerComplaintUsd", value: null, n: 0, source: world("demo"), label: "ASSUMPTION", gap: "NO_DATA" },
    ],
  },
  BATCH: {
    tab: "BATCH",
    label: "MEASURED",
    source: { kind: "BATCH", ref: "sim-batch-20261020" },
    n: 30,
    perType: Object.fromEntries(TYPES.map((type) => [type, 3])),
    kpis: [
      { key: "timeToNumberP95Ms", value: 4300, n: 28, source: { kind: "BATCH", ref: "sim-batch-20261020" }, label: "MEASURED", detail: latency },
      { key: "resolvedWithoutHumanPct", value: 63.3, n: 30, source: { kind: "BATCH", ref: "sim-batch-20261020" }, label: "MEASURED" },
      { key: "resolvedWithoutHumanPctWeighted", value: 61.2, n: 30, source: { kind: "BATCH", ref: "sim-batch-20261020" }, label: "ASSUMPTION", detail: { mix: { DATA_CHANGE: 0.1 } } },
      { key: "policyViolations", value: 0, n: 0, source: { kind: "POLICY_AUDIT", ref: "sim-batch-20261020" }, label: "MEASURED" },
      {
        key: "costPerComplaintUsd",
        value: 0.0912,
        n: 30,
        source: { kind: "BATCH", ref: "sim-batch-20261020" },
        label: "MEASURED",
        detail: { breakdown: { model: 0.08, email: 0.0002, whatsappValuedAsLive: 0.011 }, rateCardVersion: "rc-2026-10", weighted: 0.0899, reportCostUsd: 2.74 },
      },
    ],
  },
  SIMULATED_LOAD: {
    tab: "SIMULATED_LOAD",
    label: "SCRIPTED_AGENT",
    source: { kind: "SIMULATED_LOAD", ref: "sim-load" },
    n: 300,
    kpis: [
      { key: "costPerComplaintUsd", value: null, n: 0, source: { kind: "SIMULATED_LOAD", ref: "sim-load" }, label: "NOT_APPLICABLE_SCRIPTED", gap: "NOT_APPLICABLE" },
      { key: "timeToNumberP95Ms", value: null, n: 0, source: { kind: "SIMULATED_LOAD", ref: "sim-load" }, label: "NOT_APPLICABLE_SCRIPTED", gap: "NOT_APPLICABLE" },
      { key: "numberingWithoutGaps", value: true, n: 300, source: { kind: "SIMULATED_LOAD", ref: "sim-load" }, label: "SCRIPTED_AGENT", detail: { first: "R-2026-000201", last: "R-2026-000500" } },
      { key: "policyViolations", value: 0, n: 0, source: { kind: "POLICY_AUDIT", ref: "sim-load" }, label: "SCRIPTED_AGENT" },
    ],
  },
};

const CSV = "tab,key,value,n,source,label,gap\r\nWORLD,policyViolations,0,0,POLICY_AUDIT:demo,MEASURED,\r\n";

const card = (page: Page, key: string) => page.locator(`[data-kpi="${key}"]`);

test.describe("metrics", () => {
  test.beforeEach(async ({ page }) => {
    await answerWith(page, {
      "metrics.summary": (input) => SUMMARIES[input?.tab ?? "WORLD"],
      "metrics.export": (input) => ({ filename: `metrics-${(input?.tab ?? "WORLD").toLowerCase()}-2026-10-09.csv`, contentType: "text/csv; charset=utf-8", csv: CSV }),
    });
    await signIn(page, "demo", "COMPLIANCE");
    await page.goto("/app/metrics");
    await expect(page.getByRole("heading", { name: copy.views.metrics.title })).toBeVisible();
  });

  test("Este mundo: measured KPIs with N and source, nothing measured yet, the seeded history apart [FL-098]", async ({ page }) => {
    const tab = page.getByRole("tab", { name: /^Este mundo \(medido\)/ });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(metricsCopy.world.empty)).toBeVisible();

    await expect(card(page, "resolvedWithoutHumanPct")).toContainText(metricsCopy.card.noData);
    await expect(card(page, "resolvedWithoutHumanPct")).not.toContainText("%");
    await expect(card(page, "resolvedWithoutHumanPct")).toContainText("N = 0");
    await expect(card(page, "policyViolations")).toContainText(/\b0\b/);
    await expect(card(page, "policyViolations")).toContainText(metricsCopy.labels.MEASURED);
    await expect(card(page, "policyViolations")).toContainText("auditoría de política · demo");
    await expect(card(page, "timeToNumberP50Ms")).toContainText(metricsCopy.detail.untilSimulated);
    await expect(card(page, "gateDecisions")).toContainText("BLOCKED · CH-WA-NO-COLLECTION · OPERATOR: 1");
    await expect(card(page, "costPerComplaintUsd")).toContainText(metricsCopy.labels.ASSUMPTION);

    const seeded = page.getByRole("region", { name: "Historia sembrada (no medida)" });
    await expect(seeded).toContainText("120");
    await expect(seeded).toContainText(metricsCopy.world.seededLead);
    await expect(seeded).not.toContainText("%");
  });

  test("Lote · agente real: N = 30, 3 per type, raw and weighted, cost with its breakdown [FL-098]", async ({ page }) => {
    await page.getByRole("tab", { name: /^Lote · agente real/ }).click();
    await expect(page.getByText("N = 30, 3 por tipo")).toBeVisible();
    await expect(card(page, "resolvedWithoutHumanPct")).toContainText("63,3 %");
    await expect(card(page, "resolvedWithoutHumanPctWeighted")).toContainText("61,2 %");
    await expect(card(page, "resolvedWithoutHumanPctWeighted")).toContainText(metricsCopy.labels.ASSUMPTION);
    await expect(card(page, "timeToNumberP95Ms")).toContainText("4,3 s");
    await expect(card(page, "timeToNumberP95Ms")).toContainText("N = 28");
    await expect(card(page, "costPerComplaintUsd")).toContainText("US$ 0,0912");
    await expect(card(page, "costPerComplaintUsd")).toContainText("lote sim-batch-20261020");
    await expect(card(page, "costPerComplaintUsd")).toContainText("WhatsApp valorizado como vivo US$ 0,0110");
    await expect(card(page, "costPerComplaintUsd")).toContainText(`${metricsCopy.detail.weighted}: US$ 0,0899`);

    await page.getByLabel(metricsCopy.assumptions.tickets).fill("1000");
    await page.getByLabel(metricsCopy.assumptions.manualCost).fill("2,5");
    await expect(page.getByText(metricsCopy.assumptions.agent("US$ 91,20"))).toBeVisible();
    await expect(page.getByText(metricsCopy.assumptions.manual("US$ 2.500,00"))).toBeVisible();
  });

  test("Carga simulada: only the mechanics, the rest n/a — agente guionado [FL-098]", async ({ page }) => {
    await page.getByRole("tab", { name: /^Este mundo/ }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: /^Carga simulada/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/^N = 300, agente guionado/)).toBeVisible();
    await expect(card(page, "costPerComplaintUsd")).toContainText(metricsCopy.labels.NOT_APPLICABLE_SCRIPTED);
    await expect(card(page, "timeToNumberP95Ms")).toContainText(metricsCopy.labels.NOT_APPLICABLE_SCRIPTED);
    await expect(card(page, "numberingWithoutGaps")).toContainText(metricsCopy.card.yes);
    await expect(card(page, "numberingWithoutGaps")).toContainText("De R-2026-000201 a R-2026-000500");
    await expect(card(page, "numberingWithoutGaps")).toContainText(metricsCopy.labels.SCRIPTED_AGENT);
    await expect(page.locator(`[data-kpi] >> text=${metricsCopy.labels.MEASURED}`)).toHaveCount(0);
  });

  test("exports the tab as a CSV file [FL-098]", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: metricsCopy.export.button }).click()]);
    expect(download.suggestedFilename()).toBe("metrics-world-2026-10-09.csv");
    expect(await readFile((await download.path()) ?? "", "utf8")).toBe(CSV);
  });
});
