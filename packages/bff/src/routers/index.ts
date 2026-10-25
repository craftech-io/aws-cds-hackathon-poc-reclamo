// Root router of the console: one key per feature router of docs/tool-catalog.md ("Procedimientos
// de la consola"), each built from routers/roles.ts, plus the public health probe (`GET
// /api/health`). The web client is typed against `AppRouter`. This file lists every router from
// wave 1 on; each later WP replaces the file of its router and never touches this one
// (docs/build-plan.md §1, note 8).
import { accountRouter } from "./account";
import { approvalsRouter } from "./approvals";
import { clockRouter } from "./clock";
import { complaintsRouter } from "./complaints";
import { conversationRouter } from "./conversation";
import { customersRouter } from "./customers";
import { emailsRouter } from "./emails";
import { guestRouter } from "./guest";
import { healthProcedure } from "./health";
import { inboxRouter } from "./inbox";
import { metricsRouter } from "./metrics";
import { policyRouter } from "./policy";
import { registerRouter } from "./register";
import { simulatorRouter } from "./simulator";
import { tapeRouter } from "./tape";
import { tourRouter } from "./tour";
import { createCallerFactory, router } from "./trpc";

export const appRouter = router({
  health: healthProcedure,
  inbox: inboxRouter,
  complaints: complaintsRouter,
  conversation: conversationRouter,
  customers: customersRouter,
  approvals: approvalsRouter,
  tape: tapeRouter,
  register: registerRouter,
  emails: emailsRouter,
  simulator: simulatorRouter,
  clock: clockRouter,
  metrics: metricsRouter,
  policy: policyRouter,
  tour: tourRouter,
  account: accountRouter,
  guest: guestRouter,
});

export type AppRouter = typeof appRouter;

/**
 * `createCaller(createInProcessContext({ principal: inProcessPrincipal(…), deps }))`: the QaDriver runs
 * the real procedures, with `worldProcedure`, the role guards and the recent-login gate, in process.
 */
export const createCaller = createCallerFactory(appRouter);
