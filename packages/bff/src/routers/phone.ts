// `phone.*` (docs/architecture-guests.md §17): the SMS code of the signed-in account, the enrolment of
// its mobile the first time and the second factor of every sign-in session after it. They answer
// before the session passed the code (SECOND_FACTOR_PENDING_PATHS), in any status of the world, and for
// every role (COMPLIANCE included: the code is the account's, not the world's). The caller is the
// verified principal; the only inputs are a number (only while enrolling) and a code. Answers are data,
// so the console shows a fixed text per status.
import { z } from "zod";
import { ToolError } from "@reclamo/shared";
import { Locale } from "../guests/schemas";
import { secondFactorCaller } from "../second-factor/caller";
import { PhoneField } from "../second-factor/phone-number";
import type { SecondFactorService } from "../second-factor/service";
import { accessProcedure } from "./roles";
import { type WorldContext, router } from "./trpc";

/** Without the Router's header (only in process) every send shares one IP bucket: tighter, never looser. */
const NO_VIEWER_IP = "0.0.0.0";

export const PhoneSendCodeInput = z.object({ phone: PhoneField.optional(), locale: Locale.optional() }).strict();
export const PhoneVerifyInput = z.object({ code: z.string().trim().regex(/^\d{6}$/, "a six-digit code") }).strict();

function service(ctx: WorldContext): SecondFactorService {
  const build = ctx.deps.secondFactor;
  if (!build) throw new ToolError("UNAVAILABLE", "the SMS code is not configured");
  return build(ctx.log);
}

const callerOf = (ctx: WorldContext) => secondFactorCaller(ctx.principal, ctx.world);

export const phoneRouter = router({
  status: accessProcedure("phone.status").query(({ ctx }) => service(ctx).status(callerOf(ctx))),
  sendCode: accessProcedure("phone.sendCode")
    .input(PhoneSendCodeInput)
    .mutation(({ ctx, input }) => service(ctx).sendCode(callerOf(ctx), input, ctx.viewerIp ?? NO_VIEWER_IP)),
  verify: accessProcedure("phone.verify")
    .input(PhoneVerifyInput)
    .mutation(({ ctx, input }) => service(ctx).verify(callerOf(ctx), input)),
  endSession: accessProcedure("phone.endSession").mutation(({ ctx }) => service(ctx).endSession(callerOf(ctx))),
});
