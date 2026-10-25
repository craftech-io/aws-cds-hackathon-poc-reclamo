// Turns off `email_verified` for every account of the console user pool whose username has no `@`
// (staff `<role>-<nn>`, invited guests `guest-NN`, `qa-*`), docs/architecture-guests.md §2. The pool
// recovers passwords by verified email, and only a self-signup guest (username = its email) may have
// one: everybody else recovers only through an administrator. Run it before the deploy that switches
// the pool's recovery to `verified_email`, and in the post-deploy checks (docs/architecture.md §17;
// deploy.yml runs `--check` with the deploy role after `seed:load`):
//
//   npm run console:unverify-staff -- --check     read only: lists the accounts, exits 1 if any
//   npm run console:unverify-staff                sets email_verified = false on each (idempotent)
//
// It asks Cognito only for `email_verified` (`AttributesToGet`), but every Username comes back, and a
// self-signup guest's Username is its email: those are dropped in memory and never printed. Only
// usernames without `@`, which carry no personal data, are printed. Accounts with `@` are never touched.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { authConfig } from "../../packages/bff/src/auth/config";
import { verifiedStaff } from "../../packages/bff/src/auth/staff-verified";
import { awsClientConfig } from "../../packages/bff/src/lib/clients";
import { parseFlags } from "../channels/cli-args";
import { COGNITO_TIMEOUTS } from "./invite";

export interface UnverifyDeps {
  readonly cognito: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
}

export interface UnverifyOutcome {
  readonly mode: "check" | "apply";
  /** Usernames (never with `@`) whose email was verified when the run started. */
  readonly verified: readonly string[];
  readonly updated: number;
}

export function parseUnverifyArgs(argv: readonly string[]): { check: boolean } {
  let check = false;
  parseFlags(argv, {
    "--check": () => {
      check = true;
    },
  });
  return { check };
}

export async function runUnverify(check: boolean, deps: UnverifyDeps): Promise<UnverifyOutcome> {
  const verified = await verifiedStaff(deps.cognito, deps.userPoolId);
  if (check) return { mode: "check", verified, updated: 0 };
  for (const username of verified) {
    await deps.cognito.send(
      new AdminUpdateUserAttributesCommand({ UserPoolId: deps.userPoolId, Username: username, UserAttributes: [{ Name: "email_verified", Value: "false" }] }),
    );
  }
  return { mode: "apply", verified, updated: verified.length };
}

export function describeUnverify(outcome: UnverifyOutcome): string {
  const names = outcome.verified.length > 0 ? `: ${outcome.verified.join(", ")}` : "";
  if (outcome.mode === "check") return `console:unverify-staff: ${outcome.verified.length} account(s) without @ with a verified email${names}`;
  return `console:unverify-staff: email_verified set to false on ${outcome.updated} account(s)${names}`;
}

/** Exit code: `--check` fails while any account without `@` still has a verified email. */
export function exitCodeOf(outcome: UnverifyOutcome): number {
  return outcome.mode === "check" && outcome.verified.length > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  let check: boolean;
  try {
    ({ check } = parseUnverifyArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`console:unverify-staff: ${error instanceof Error ? error.message : String(error)}\nusage: npm run console:unverify-staff [-- --check]`);
    process.exit(2);
  }
  const auth = authConfig();
  const deps: UnverifyDeps = {
    cognito: new CognitoIdentityProviderClient({ region: auth.region, ...awsClientConfig(COGNITO_TIMEOUTS) }),
    userPoolId: auth.userPoolId,
  };
  const outcome = await runUnverify(check, deps);
  console.log(describeUnverify(outcome));
  process.exit(exitCodeOf(outcome));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`console:unverify-staff: ${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
