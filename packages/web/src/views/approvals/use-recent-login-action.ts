// An action that needs a sign-in of at most 15 minutes (approving money, answering in writing;
// ADR-0005). The BFF decides: when it refuses with `LOGIN_NOT_RECENT` the bilingual password prompt
// of the console opens in place (views/login/SecurityPrompts.tsx) and the action waits. A step-up
// that ends with a new `auth_time` runs the same action once more; closing the prompt without one
// drops it, so the refusal stays on screen and nothing else happens.
import { useEffect, useLayoutEffect, useRef } from "react";
import { useSession } from "../../context/SessionContext";
import { apiErrorOf } from "../../lib/api-error";
import { type Action, useAction } from "../../lib/use-remote";

export function useRecentLoginAction<I, T>(perform: (input: I) => Promise<T>, onDone?: (data: T) => void): Action<I, T> {
  const { state, prompt, openPrompt } = useSession();
  const onDoneRef = useRef(onDone);
  useLayoutEffect(() => {
    onDoneRef.current = onDone;
  });
  const pending = useRef<{ readonly input: I } | undefined>(undefined);

  const action = useAction<I, T>(async (input) => {
    try {
      const data = await perform(input);
      onDoneRef.current?.(data);
      return data;
    } catch (error) {
      if (apiErrorOf(error).kind === "recentLogin") {
        pending.current = { input };
        openPrompt("stepUp");
      }
      throw error;
    }
  });

  const authTime = state.status === "authenticated" ? state.principal.authTime : undefined;
  const seenAuthTime = useRef(authTime);
  const { run } = action;
  useEffect(() => {
    if (authTime === seenAuthTime.current) return;
    seenAuthTime.current = authTime;
    const retry = pending.current;
    pending.current = undefined;
    if (retry !== undefined) void run(retry.input);
  }, [authTime, run]);

  const lastPrompt = useRef(prompt);
  useEffect(() => {
    if (lastPrompt.current === "stepUp" && prompt === undefined) pending.current = undefined;
    lastPrompt.current = prompt;
  }, [prompt]);

  return action;
}
