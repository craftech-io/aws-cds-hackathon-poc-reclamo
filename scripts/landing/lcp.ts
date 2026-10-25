// The landing's performance budget (docs/landing-spec.md §8, FL-102): on the production build served
// locally, with the network and the CPU of a phone on 4G (150 ms round trip, 1.6 Mbps down, 750 kbps up,
// CPU four times slower), the Largest Contentful Paint stays under 2.5 s and the main thread is not
// blocked (Total Blocking Time under 200 ms until the page settles), in a phone's and a desktop's
// viewport, in both languages; and no console capture (lazy, below the fold) starts downloading before
// the largest paint.
//
//   npm run landing:lcp
import { type Browser, chromium } from "@playwright/test";
import { runAsCommand } from "./cli";
import { buildConsole } from "./console-build";
import { startStaticServer } from "./static-files";

export const LCP_BUDGET_MS = 2_500;
export const TBT_BUDGET_MS = 200;
/** Lighthouse's "slow 4G" throttling of a mobile run. */
export const NETWORK_4G = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } as const;
export const CPU_SLOWDOWN = 4;
const SETTLE_MS = 4_000;

export interface Measure {
  readonly page: string;
  readonly lcpMs: number;
  readonly tbtMs: number;
  /** Console captures whose download started before the largest paint (expected: none). */
  readonly capturesBeforeLcp: number;
}

/** Runs in the page from the first byte: records the LCP and the long tasks. */
const OBSERVE = `(() => {
  window.__perf = { lcp: 0, tbt: 0 };
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__perf.lcp = entry.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__perf.tbt += Math.max(0, entry.duration - 50); }).observe({ type: "longtask", buffered: true });
})()`;

async function measure(browser: Browser, origin: string, path: string, viewport: { width: number; height: number }): Promise<Measure> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 768 ? 3 : 1, locale: "es-AR", isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
  try {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", NETWORK_4G);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
    await page.addInitScript(OBSERVE);
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    await page.waitForTimeout(SETTLE_MS);
    const perf = await page.evaluate<{ lcp: number; tbt: number; early: number }>(
      `({ ...window.__perf, early: performance.getEntriesByType("resource").filter((entry) => /\\/landing\\/(tour|gallery)-/.test(entry.name) && entry.startTime < window.__perf.lcp).length })`,
    );
    return { page: `${path} ${viewport.width}x${viewport.height}`, lcpMs: Math.round(perf.lcp), tbtMs: Math.round(perf.tbt), capturesBeforeLcp: perf.early };
  } finally {
    await context.close();
  }
}

export function budgetProblems(measures: readonly Measure[]): string[] {
  return measures.flatMap((m) => [
    ...(m.lcpMs >= LCP_BUDGET_MS ? [`${m.page}: LCP ${m.lcpMs} ms, budget ${LCP_BUDGET_MS} ms`] : []),
    ...(m.tbtMs >= TBT_BUDGET_MS ? [`${m.page}: total blocking time ${m.tbtMs} ms, budget ${TBT_BUDGET_MS} ms`] : []),
    ...(m.capturesBeforeLcp > 0 ? [`${m.page}: ${m.capturesBeforeLcp} console capture(s) started before the largest paint`] : []),
  ]);
}

async function main(): Promise<void> {
  const build = await buildConsole();
  const server = await startStaticServer(build.dir);
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome" });
  try {
    const measures: Measure[] = [];
    for (const path of ["/", "/?lang=en"]) for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) measures.push(await measure(browser, server.origin, path, viewport));
    for (const m of measures) process.stdout.write(`${m.page.padEnd(24)} LCP ${String(m.lcpMs).padStart(5)} ms   TBT ${String(m.tbtMs).padStart(4)} ms   captures before LCP ${m.capturesBeforeLcp}\n`);
    const problems = budgetProblems(measures);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    process.stdout.write(`landing-lcp: within budget (LCP < ${LCP_BUDGET_MS} ms, TBT < ${TBT_BUDGET_MS} ms) on 4G with a ${CPU_SLOWDOWN}x slower CPU\n`);
  } finally {
    await browser.close();
    await server.close();
    build.remove();
  }
}

runAsCommand("landing-lcp", import.meta.filename, main);
