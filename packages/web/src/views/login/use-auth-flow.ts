// React side of the sign-in machine (lib/auth/flow.ts): the current state, the error of the last
// step and a busy flag; `dispatch` runs one action. When the machine reaches `done`, `onDone` gets
// the tokens exactly once.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import { type AuthFlowAction, type AuthFlowDeps, type AuthFlowState, INITIAL_STATE, advance } from "../../lib/auth/flow";

export interface AuthFlowHandle {
  readonly state: AuthFlowState;
  readonly error: AuthFlowErrorCode | undefined;
  readonly busy: boolean;
  dispatch(action: AuthFlowAction): void;
}

export function useAuthFlow(
  deps: AuthFlowDeps | undefined,
  onDone: (state: Extract<AuthFlowState, { step: "done" }>) => void,
  initial: AuthFlowState = INITIAL_STATE,
): AuthFlowHandle {
  const [state, setState] = useState<AuthFlowState>(initial);
  const [error, setError] = useState<AuthFlowErrorCode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const dispatch = useCallback(
    (action: AuthFlowAction) => {
      if (!deps || running.current) return;
      running.current = true;
      setBusy(true);
      void advance(state, action, deps)
        .then((transition) => {
          setState(transition.state);
          setError(transition.error);
        })
        .finally(() => {
          running.current = false;
          setBusy(false);
        });
    },
    [deps, state],
  );

  useEffect(() => {
    if (state.step === "done") onDoneRef.current(state);
  }, [state]);

  return { state, error, busy, dispatch };
}
