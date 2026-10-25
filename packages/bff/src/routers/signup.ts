// The public procedures of the self-signup (docs/architecture-guests.md §4): `signup.availability`,
// `signup.start`, `signup.confirm`, `signup.resend`, `password.forgot` and `password.reset`. They need
// no token (`publicEdgeProcedure`) and are served ONLY under `/api/public/<procedure>`, one per
// request, never batched (routers/public-handler.ts): tRPC writes a batch into the path, so a rule of
// the edge WAF "starts with /api/signup." would be dodged by putting another procedure first. Their
// own tRPC instance keeps them out of the console's root router: `/api/*` cannot reach them at all.
// Answers are data (`{ status }`), so the console shows a fixed text per status.
import { initTRPC } from "@trpc/server";
import type { PasswordService } from "../guests/password";
import {
  PasswordForgotInput,
  PasswordResetInput,
  SignupConfirmInput,
  SignupResendInput,
  SignupStartInput,
} from "../guests/schemas";
import type { SignupService } from "../guests/signup";
import type { Logger } from "../lib/log";

export interface PublicServices {
  readonly signup: SignupService;
  readonly password: PasswordService;
}

export interface PublicContext {
  readonly correlationId: string;
  readonly log: Logger;
  /** The address CloudFront saw (`x-reclamo-viewer-ip`), hashed before anything stores it. */
  readonly viewerIp: string;
  readonly services: () => PublicServices;
}

const t = initTRPC.context<PublicContext>().create({
  isDev: false,
  errorFormatter({ shape, ctx }) {
    // Never the zod issues: they would echo what the visitor typed.
    return { ...shape, data: { code: shape.data.code, httpStatus: shape.data.httpStatus, correlationId: ctx?.correlationId ?? null } };
  },
});

/** A procedure of the public edge: no principal; the handler already refused batches and foreign paths. */
export const publicEdgeProcedure = t.procedure;

export const signupRouter = t.router({
  availability: publicEdgeProcedure.query(({ ctx }) => ctx.services().signup.availability()),
  start: publicEdgeProcedure.input(SignupStartInput).mutation(({ ctx, input }) => ctx.services().signup.start(input, ctx.viewerIp)),
  confirm: publicEdgeProcedure.input(SignupConfirmInput).mutation(({ ctx, input }) => ctx.services().signup.confirm(input)),
  resend: publicEdgeProcedure.input(SignupResendInput).mutation(({ ctx, input }) => ctx.services().signup.resend(input)),
});

export const passwordRouter = t.router({
  forgot: publicEdgeProcedure.input(PasswordForgotInput).mutation(({ ctx, input }) => ctx.services().password.forgot(input, ctx.viewerIp)),
  reset: publicEdgeProcedure.input(PasswordResetInput).mutation(({ ctx, input }) => ctx.services().password.reset(input)),
});

export const publicRouter = t.router({ signup: signupRouter, password: passwordRouter });

export type PublicRouter = typeof publicRouter;

/** Every public procedure path (`signup.start`, …), for the handler's guards and the tests. */
export const PUBLIC_PROCEDURES: readonly string[] = Object.keys(publicRouter._def.procedures);

export const createPublicCaller = t.createCallerFactory(publicRouter);
