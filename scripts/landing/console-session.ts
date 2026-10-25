// The console's session as the captures plant it: the key under which the console keeps its token set in
// sessionStorage (packages/web/src/lib/auth/tokens.ts `TOKENS_KEY`, which landing.test.ts compares with
// this one: importing it here would pull the console's DOM-typed modules into a Node script) and the
// init script that stores a token set before the console's own scripts run.
export const CONSOLE_TOKENS_KEY = "reclamo.console.tokens";

export interface PlantedTokens {
  readonly idToken: string;
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/** Source of an init script that stores `tokens` where the console reads them. */
export function plantSessionScript(tokens: PlantedTokens): string {
  return `window.sessionStorage.setItem(${JSON.stringify(CONSOLE_TOKENS_KEY)}, ${JSON.stringify(JSON.stringify(tokens))})`;
}
