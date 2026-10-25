// The public procedures of the self-signup (docs/architecture-guests.md §4): `signup.availability`,
// `signup.start`, `signup.confirm`, `signup.resend`, `password.forgot` and `password.reset`. They are
// served ONLY at `/api/public/<procedure>`, one per request and never batched, so this client speaks
// tRPC v11's plain HTTP shape itself (a GET for the query, a POST with the bare input for the
// mutations) instead of the console's batching link. Every answer is data (`{ status }`) parsed with
// zod; the inputs are typed from the BFF's router, so a renamed field breaks the build.
//
// What the edge answers before the BFF is told apart (docs/architecture-guests.md §8): a request
// WAF wants to challenge again (202 with `x-amzn-waf-action: challenge`, or a 403 that is not the
// BFF's JSON) is `challenge`, and the page reloads itself once by a full navigation; WAF's rate rule
// (429) reads as `RATE_LIMITED`, like the BFF's own caps.
//
// Retries: the query retries like every GET (fetchWithRetry). A mutation is sent once: `start`,
// `resend` and `forgot` send an email and `confirm`/`reset` consume a code, so a timeout is shown to
// the person instead of being repeated behind their back.
import type { PublicRouter } from "@reclamo/bff/routers/signup";
import type { inferRouterInputs } from "@trpc/server";
import { z } from "zod";
import { fetchWithRetry } from "../http";

export type PublicInputs = inferRouterInputs<PublicRouter>;
export type SignupStartInput = PublicInputs["signup"]["start"];
export type SignupConfirmInput = PublicInputs["signup"]["confirm"];
export type PasswordForgotInput = PublicInputs["password"]["forgot"];
export type PasswordResetInput = PublicInputs["password"]["reset"];

/** Where the public procedures live behind the Router (`PUBLIC_PREFIX` of routers/public-handler.ts). */
export const PUBLIC_API_URL = "/api/public";
export const WAF_ACTION_HEADER = "x-amzn-waf-action";

export const SignupAvailability = z.object({ status: z.enum(["open", "closed"]) });
export const SignupStartResult = z.union([
  z.object({ status: z.literal("CODE_SENT"), signupId: z.string().regex(/^[a-z2-7]{26}$/) }),
  z.object({ status: z.enum(["EMAIL_TAKEN", "INVALID_EMAIL", "EMAIL_NOT_ACCEPTED", "WEAK_PASSWORD", "CONSENT_REQUIRED", "RATE_LIMITED", "SIGNUP_UNAVAILABLE"]) }),
]);
export const SignupConfirmResult = z.union([
  z.object({ status: z.literal("CONFIRMED"), worldStatus: z.string(), email: z.string() }),
  z.object({ status: z.enum(["CODE_MISMATCH", "CODE_EXPIRED", "SIGNUP_RESTART", "RATE_LIMITED"]) }),
]);
export const SignupResendResult = z.object({ status: z.enum(["CODE_SENT", "RATE_LIMITED"]) });
export const PasswordForgotResult = z.object({ status: z.enum(["CODE_SENT_IF_EXISTS", "RATE_LIMITED"]) });
export const PasswordResetResult = z.object({ status: z.enum(["PASSWORD_CHANGED", "CODE_MISMATCH", "CODE_EXPIRED", "WEAK_PASSWORD", "RATE_LIMITED"]) });

export type SignupAvailability = z.infer<typeof SignupAvailability>;
export type SignupStartResult = z.infer<typeof SignupStartResult>;
export type SignupConfirmResult = z.infer<typeof SignupConfirmResult>;
export type SignupResendResult = z.infer<typeof SignupResendResult>;
export type PasswordForgotResult = z.infer<typeof PasswordForgotResult>;
export type PasswordResetResult = z.infer<typeof PasswordResetResult>;

/** Why a public call gave no answer: the edge wants a fresh challenge, the network, or the server. */
export type PublicFailure = "challenge" | "network" | "server";

export class PublicApiError extends Error {
  override readonly name = "PublicApiError";
  constructor(
    readonly kind: PublicFailure,
    message: string,
  ) {
    super(message);
  }
}

const RATE_LIMITED = { status: "RATE_LIMITED" } as const;
const QUERY_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 20_000;
const Envelope = z.object({ result: z.object({ data: z.unknown() }) });

function isJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

/** WAF's answers before the BFF (§8): a challenge to solve again, or a block that is not JSON. */
export function isWafChallenge(response: Response): boolean {
  if (response.status === 202 && response.headers.get(WAF_ACTION_HEADER)?.trim().toLowerCase() === "challenge") return true;
  return response.status === 403 && !isJson(response);
}

export interface PublicApi {
  availability(): Promise<SignupAvailability>;
  start(input: SignupStartInput): Promise<SignupStartResult>;
  confirm(input: SignupConfirmInput): Promise<SignupConfirmResult>;
  resend(signupId: string): Promise<SignupResendResult>;
  forgot(input: PasswordForgotInput): Promise<PasswordForgotResult>;
  reset(input: PasswordResetInput): Promise<PasswordResetResult>;
}

export interface PublicApiOptions {
  readonly fetch?: typeof fetchWithRetry;
  readonly baseUrl?: string;
}

export function createPublicApi(options: PublicApiOptions = {}): PublicApi {
  const doFetch = options.fetch ?? fetchWithRetry;
  const base = options.baseUrl ?? PUBLIC_API_URL;

  async function call<T>(procedure: string, schema: z.ZodType<T>, input?: unknown): Promise<T | typeof RATE_LIMITED> {
    const query = input === undefined;
    let response: Response;
    try {
      response = query
        ? await doFetch(`${base}/${procedure}`, { method: "GET", headers: { accept: "application/json" } }, { timeoutMs: QUERY_TIMEOUT_MS })
        : await doFetch(
            `${base}/${procedure}`,
            { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input) },
            { attempts: 1, timeoutMs: MUTATION_TIMEOUT_MS },
          );
    } catch (error) {
      throw new PublicApiError("network", error instanceof Error ? error.name : "fetch failed");
    }
    if (isWafChallenge(response)) throw new PublicApiError("challenge", `edge answered ${response.status}`);
    if (response.status === 429) return RATE_LIMITED;
    if (!response.ok || !isJson(response)) throw new PublicApiError("server", `${procedure} answered ${response.status}`);
    const envelope = Envelope.safeParse(await response.json().catch(() => undefined));
    const parsed = envelope.success ? schema.safeParse(envelope.data.result.data) : undefined;
    if (!parsed?.success) throw new PublicApiError("server", `${procedure} answered an unexpected shape`);
    return parsed.data;
  }

  return {
    availability: async () => {
      const answer = await call("signup.availability", SignupAvailability);
      // The edge's rate rule never counts this GET (§8); a 429 here still reads as "not now".
      return answer.status === "RATE_LIMITED" ? { status: "closed" } : answer;
    },
    start: (input) => call("signup.start", SignupStartResult, input),
    confirm: (input) => call("signup.confirm", SignupConfirmResult, input),
    resend: (signupId) => call("signup.resend", SignupResendResult, { signupId }),
    forgot: (input) => call("password.forgot", PasswordForgotResult, input),
    reset: (input) => call("password.reset", PasswordResetResult, input),
  };
}

/** The browser's client of the public procedures (same origin, behind the Router). */
export const publicApi: PublicApi = createPublicApi();
