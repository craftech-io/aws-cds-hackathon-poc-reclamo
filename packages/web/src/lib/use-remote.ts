// Data loading for the views without a state library (CLAUDE.md): `useRemote` runs a query while
// its key is set and aborts it when the key changes or the view unmounts; `useAction` runs one
// mutation at a time and keeps its outcome. Both hand the views an `ApiError`, never a raw throw.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ApiError, apiErrorOf } from "./api-error";

export type RemoteState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly previous?: T }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly error: ApiError };

export interface Remote<T> {
  readonly state: RemoteState<T>;
  /** Runs the same query again (after a mutation that changed what it shows). */
  reload(): void;
}

function previousOf<T>(state: RemoteState<T>): T | undefined {
  if (state.status === "ready") return state.data;
  if (state.status === "loading") return state.previous;
  return undefined;
}

/**
 * Runs `load` whenever `key` changes; `key = null` means "nothing to load yet" (no complaint
 * selected, a role that cannot call the procedure). The key must encode every input of `load`.
 */
export function useRemote<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Remote<T> {
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  const [state, setState] = useState<RemoteState<T>>(key === null ? { status: "idle" } : { status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (key === null) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((current) => {
      const previous = previousOf(current);
      return previous === undefined ? { status: "loading" } : { status: "loading", previous };
    });
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", error: apiErrorOf(error) });
      },
    );
    return () => controller.abort();
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { state, reload };
}

/**
 * `useRemote` over an input that may not exist yet (no complaint chosen, a role that cannot ask):
 * no input, no query. The key is the procedure name plus the serialized input.
 */
export function useRemoteInput<I, T>(name: string, input: I | undefined, load: (input: I, signal: AbortSignal) => Promise<T>): Remote<T> {
  return useRemote(input === undefined ? null : `${name}:${JSON.stringify(input)}`, (signal) =>
    // Unreachable with a null key; kept so the loader type never sees `undefined`.
    input === undefined ? Promise.reject(new Error(`${name}: no input`)) : load(input, signal),
  );
}

/** Data of a remote state, or what it showed before the current reload. */
export function dataOf<T>(state: RemoteState<T>): T | undefined {
  return previousOf(state);
}

export type ActionState<T> =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "done"; readonly data: T }
  | { readonly status: "error"; readonly error: ApiError };

export interface Action<I, T> {
  readonly state: ActionState<T>;
  /** Resolves with the result, or `undefined` when it failed (the error is in `state`). */
  run(input: I): Promise<T | undefined>;
  reset(): void;
}

/** One mutation at a time: a second `run` while the first is in flight is ignored, so a double click never sends twice. */
export function useAction<I, T>(perform: (input: I) => Promise<T>): Action<I, T> {
  const performRef = useRef(perform);
  useLayoutEffect(() => {
    performRef.current = perform;
  });
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [state, setState] = useState<ActionState<T>>({ status: "idle" });

  const run = useCallback(async (input: I): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setState({ status: "running" });
    try {
      const data = await performRef.current(input);
      if (mounted.current) setState({ status: "done", data });
      return data;
    } catch (error) {
      if (mounted.current) setState({ status: "error", error: apiErrorOf(error) });
      return undefined;
    } finally {
      running.current = false;
    }
  }, []);

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}
