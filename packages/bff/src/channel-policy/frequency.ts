// `CH-MAX-PER-DAY` (docs/design-brief.md §7, an assumption the console labels as such): at most
// `SETTINGS.maxProactivePerDay` (3) proactive contacts per customer and simulated day in Buenos
// Aires, adding up both channels (counted over the `ByCustomerSent` history), and one formal debt
// notice every `formalNoticeEveryDays` (7). What counts is what already went out before the decided
// send; a reply, the written answer and the confirmations never count. A fourth contact is deferred
// to the next day; a second formal notice inside the 7 days is blocked.
import { addCalendarDays } from "@reclamo/shared";
import { localDateAr } from "../services/business-days";
import { atLocalAr, block, defer, missing, pass, skip, wallClockAr } from "./checks";
import type { PolicyContext } from "./context";
import { proactiveOf } from "./hours";
import { FORMAL_NOTICE, wasProactive, wentOut } from "./kinds";
import type { HistoryMessage, RuleCheck } from "./types";

const DAY_MS = 86_400_000;

/** Went out before the decided send: earlier simulated instant, then earlier real instant, then id. */
function isBefore(entry: HistoryMessage, at: Date, ctx: PolicyContext): boolean {
  const sim = Date.parse(entry.atSim) - at.getTime();
  if (sim !== 0) return sim < 0;
  // A later instant than "now" is a candidate of the engine's search: everything known went out before it.
  if (at.getTime() !== ctx.simNow.getTime()) return true;
  if (entry.atReal !== undefined) {
    const real = Date.parse(entry.atReal) - ctx.realNow.getTime();
    if (real !== 0) return real < 0;
  }
  return ctx.request.messageId === undefined || entry.messageId < ctx.request.messageId;
}

function checkFormalNotice(ctx: PolicyContext, history: readonly HistoryMessage[], at: Date): RuleCheck {
  const days = ctx.settings.formalNoticeEveryDays;
  const since = at.getTime() - days * DAY_MS;
  const earlier = history.find((entry) => entry.kind === FORMAL_NOTICE && wentOut(entry) && Date.parse(entry.atSim) > since && isBefore(entry, at, ctx));
  if (earlier === undefined) return pass(`no formal debt notice reached this customer in the last ${days} days`);
  return block(`a formal debt notice already reached this customer on ${wallClockAr(new Date(earlier.atSim))}: one every ${days} days`);
}

/** `CH-MAX-PER-DAY` at `at`. */
export function checkMaxPerDay(ctx: PolicyContext, at: Date): RuleCheck {
  const proactive = proactiveOf(ctx);
  if (proactive === undefined) return missing(ctx.mode, "the customer's message history");
  if (!proactive) return skip("only proactive contacts count against the daily cap");
  const { history } = ctx;
  if (history === undefined) return missing(ctx.mode, "the customer's message history");
  if (ctx.request.kind === FORMAL_NOTICE) {
    const notice = checkFormalNotice(ctx, history, at);
    if (notice.result !== "PASS") return notice;
  }
  const max = ctx.settings.maxProactivePerDay;
  if (max === 0) return block("this world allows no proactive contact");
  const day = localDateAr(at);
  const sent = history.filter((entry) => wentOut(entry) && wasProactive(entry) && localDateAr(new Date(entry.atSim)) === day && isBefore(entry, at, ctx)).length;
  const date = `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  if (sent < max) return pass(`${sent} of ${max} proactive contacts reached this customer on ${date}`);
  const next = atLocalAr(addCalendarDays(day, 1), "00:00");
  return defer(`${sent} proactive contacts already reached this customer on ${date} (max ${max}): deferred to the next day`, next);
}
