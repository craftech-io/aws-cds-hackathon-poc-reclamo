// The accounts of the console user pool that must not recover a password by email (docs/architecture-guests.md
// §2): every username without `@` (staff `<role>-<nn>`, invited guests `guest-NN`, `qa-*`) whose
// `email_verified` is `true`. Read only by `console:unverify-staff` (scripts/console/unverify-staff.ts),
// which runs with the operator's or the deploy role's credentials, never by a Lambda. `AttributesToGet`
// keeps every attribute but `email_verified` out of the answer, but ListUsers always returns the
// Username, and a self-signup guest's Username IS its email (guests/cognito-port.ts): every lead's
// address passes through this loop. It is dropped here (only usernames without `@` are kept) and never
// logged; that is why no role of the app's Lambdas has `cognito-idp:ListUsers` for this read.
import { type CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";

/** ListUsers' largest page. */
export const PAGE_SIZE = 60;

/** Accounts without `@` in the username and `email_verified = true`, in the pool's order. */
export async function verifiedStaff(cognito: Pick<CognitoIdentityProviderClient, "send">, userPoolId: string): Promise<string[]> {
  const found: string[] = [];
  let token: string | undefined;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: PAGE_SIZE, AttributesToGet: ["email_verified"], ...(token ? { PaginationToken: token } : {}) }));
    for (const user of page.Users ?? []) {
      const username = user.Username ?? "";
      const verified = user.Attributes?.some((attribute) => attribute.Name === "email_verified" && attribute.Value === "true") ?? false;
      if (username !== "" && !username.includes("@") && verified) found.push(username);
    }
    token = page.PaginationToken;
  } while (token);
  return found;
}
