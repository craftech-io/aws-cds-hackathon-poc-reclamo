// The console's procedures as the scenarios call them through the `QaDriver` (`console`: the real
// `appRouter` with a principal built on the server, docs/tool-catalog.md "Acciones del QaDriver"), typed
// from the router itself so a changed procedure breaks the scenario at compile time instead of in `poc`.
// `worldProcedure`, the role guards and the recent-login gate run for real: a refusal comes back as the
// domain's code and reason (`FORBIDDEN CROSS_WORLD`, `ROLE`, `RECENT_LOGIN`).
import type { QaResponse } from "@reclamo/bff/qa-driver/contract";
import type { AppRouter } from "@reclamo/bff/routers/index";
import type { StaffRole } from "@reclamo/shared";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { ScenarioContext } from "./steps";

export type ConsoleInputs = inferRouterInputs<AppRouter>;
export type ConsoleOutputs = inferRouterOutputs<AppRouter>;

type Router = Exclude<keyof ConsoleOutputs & string, "health">;
type Procedure<R extends Router> = keyof ConsoleOutputs[R] & string;

export interface ConsoleCallOptions {
  readonly worldId: string;
  /** `OPERATOR` unless the step proves another role. */
  readonly role?: StaffRole;
  /** How long ago the principal signed in; recent-login procedures refuse past 15 minutes. */
  readonly signedInSecAgo?: number;
}

function actionOf(router: string, procedure: string, input: unknown, options: ConsoleCallOptions, now: number) {
  return {
    worldId: options.worldId,
    procedure: `${router}.${procedure}`,
    role: options.role ?? "OPERATOR",
    ...(input === undefined ? {} : { input }),
    ...(options.signedInSecAgo === undefined ? {} : { authTime: Math.floor(now / 1_000) - options.signedInSecAgo }),
  };
}

/** One console procedure; a refusal throws `DriverRefusal`. */
export async function consoleCall<R extends Router, P extends Procedure<R>>(
  ctx: ScenarioContext,
  router: R,
  procedure: P,
  input: ConsoleInputs[R][P],
  options: ConsoleCallOptions,
): Promise<ConsoleOutputs[R][P]> {
  return (await ctx.qa("console", actionOf(router, procedure, input, options, ctx.now()))) as ConsoleOutputs[R][P];
}

/** The same call, answered as it is: for a refusal the step expects. */
export function consoleAttempt<R extends Router, P extends Procedure<R>>(
  ctx: ScenarioContext,
  router: R,
  procedure: P,
  input: ConsoleInputs[R][P],
  options: ConsoleCallOptions,
): Promise<QaResponse<ConsoleOutputs[R][P]>> {
  return ctx.attempt("console", actionOf(router, procedure, input, options, ctx.now())) as Promise<QaResponse<ConsoleOutputs[R][P]>>;
}

export type CaseView = ConsoleOutputs["complaints"]["get"];
export type Timeline = ConsoleOutputs["complaints"]["timeline"];
export type TimelineItem = Timeline["items"][number];

/** The items of one type of a complaint's timeline (`MESSAGE`, `EMAIL`, `TAPE`, `ACTION`, `MILESTONE`, `REGISTER`, `STATUS`, `NOTE`). */
export function itemsOf<T extends TimelineItem["type"]>(timeline: Timeline, type: T): Array<Extract<TimelineItem, { type: T }>> {
  return timeline.items.filter((item): item is Extract<TimelineItem, { type: T }> => item.type === type);
}

export function caseOf(ctx: ScenarioContext, worldId: string, complaintId: string): Promise<CaseView> {
  return consoleCall(ctx, "complaints", "get", { complaintId }, { worldId });
}

export function timelineOf(ctx: ScenarioContext, worldId: string, complaintId: string): Promise<Timeline> {
  return consoleCall(ctx, "complaints", "timeline", { complaintId }, { worldId });
}

/** Tool calls of the agent and console actions recorded for the complaint (`READ_RECEIPT`, `APPLY_PAYMENT`…). */
export function toolCalls(timeline: Timeline, action: string): Array<Extract<TimelineItem, { type: "ACTION" }>> {
  return itemsOf(timeline, "ACTION").filter((item) => item.action === action);
}

/** The details of the case's evidence of `kind` (`RECEIPT_READING`, `SETTLEMENT_MATCH`…), oldest first. */
export function evidenceDetails(view: CaseView, kind: string): Array<Readonly<Record<string, unknown>>> {
  return view.evidence.filter((item) => item.kind === kind).map((item) => item.details as Readonly<Record<string, unknown>>);
}

/** The `result` of the latest evidence of `kind`, if any. */
export function latestResult(view: CaseView, kind: string): string | undefined {
  const result = evidenceDetails(view, kind).at(-1)?.["result"];
  return typeof result === "string" ? result : undefined;
}
