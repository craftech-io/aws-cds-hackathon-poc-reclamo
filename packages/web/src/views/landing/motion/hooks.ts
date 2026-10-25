// The few hooks the landing's motion needs (docs/landing-spec.md §4): one IntersectionObserver per
// use (never a scroll listener), the reduced-motion preference, the reveal of sections, the tour's
// active step, the self-typing bubble, the counters and the hero's loop. Every hook settles on the
// final state when motion is reduced or the browser lacks the API, so no content waits for an
// animation (the CSS of index.css hides nothing under `prefers-reduced-motion: reduce` either).
import { type RefObject, useEffect, useRef, useState } from "react";
import { COUNT_UP_MS, HERO_LOOP_MS, HERO_STAGES, countUpValue, heroStage, typedLength } from "./timing";

/** Whether `query` matches; `fallback` without a window (server rendering, tests). */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" || typeof window.matchMedia !== "function" ? fallback : window.matchMedia(query).matches));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Without a window the content renders in its final state, as if motion were reduced. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)", true);
}

interface InViewOptions {
  readonly threshold?: number;
  readonly rootMargin?: string;
  /** Stop observing once the element has been seen. */
  readonly once?: boolean;
}

export function useInView(ref: RefObject<Element | null>, { threshold = 0, rootMargin = "0px", once = false }: InViewOptions = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        setInView(visible);
        if (visible && once) observer.disconnect();
      },
      { threshold, rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold, rootMargin, once]);
  return inView;
}

/**
 * Reveal on entering the viewport: every `[data-reveal]` under `root` is marked `pending` until 20 %
 * of it is visible and `shown` after. Only while motion may run; index.css applies the hidden state
 * of `pending` under `prefers-reduced-motion: no-preference` only.
 */
export function useReveal(root: RefObject<HTMLElement | null>, animate: boolean): void {
  useEffect(() => {
    const container = root.current;
    if (!container || !animate || typeof IntersectionObserver === "undefined") return;
    const elements = [...container.querySelectorAll<HTMLElement>("[data-reveal]")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.reveal = "shown";
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.2 },
    );
    for (const element of elements) {
      if (element.dataset.reveal === "shown") continue;
      element.dataset.reveal = "pending";
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      for (const element of elements) element.dataset.reveal = "shown";
    };
  }, [root, animate]);
}

/** The band in the middle of the viewport that marks a tour step active (docs/landing-spec.md §3). */
export const ACTIVE_STEP_MARGIN = "-45% 0px -45% 0px";

/** Index of the step block whose centre crosses the viewport's centre; the last one crossed stays active. */
export function useActiveStep(container: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const root = container.current;
    if (!root || !enabled || typeof IntersectionObserver === "undefined") return;
    const blocks = [...root.querySelectorAll<HTMLElement>("[data-step-index]")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setActive(Number((entry.target as HTMLElement).dataset.stepIndex ?? 0));
        }
      },
      { rootMargin: ACTIVE_STEP_MARGIN },
    );
    for (const block of blocks) observer.observe(block);
    return () => observer.disconnect();
  }, [container, enabled]);
  return active;
}

/** Runs `onFrame(elapsedMs)` on every animation frame while `run` holds; `onFrame` returns false to stop. */
function useFrames(run: boolean, onFrame: (elapsedMs: number) => boolean): void {
  // The latest callback, read on each frame: only the run flag restarts the frames.
  const callback = useRef(onFrame);
  callback.current = onFrame;
  useEffect(() => {
    if (!run) return;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      if (callback.current(now - startedAt)) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run]);
}

/** Visible characters of `text`: typed once when `start` turns true, the whole text when motion is reduced. */
export function useTypewriter(text: string, start: boolean, reduced: boolean): number {
  const [shown, setShown] = useState(reduced ? text.length : 0);
  const [done, setDone] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setShown(text.length);
      setDone(true);
    }
  }, [reduced, text.length]);
  useFrames(start && !done, (elapsed) => {
    const next = typedLength(text.length, elapsed);
    setShown(next);
    if (next < text.length) return true;
    setDone(true);
    return false;
  });
  return done ? text.length : shown;
}

/** Counts from 0 to `target` once `start` turns true; `target` at once when motion is reduced. */
export function useCountUp(target: number, start: boolean, reduced: boolean): number {
  const [value, setValue] = useState(reduced ? target : 0);
  const [done, setDone] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setValue(target);
      setDone(true);
    }
  }, [reduced, target]);
  useFrames(start && !done, (elapsed) => {
    setValue(countUpValue(target, elapsed));
    if (elapsed < COUNT_UP_MS) return true;
    setDone(true);
    return false;
  });
  return done ? target : value;
}

/** The hero's loop stage (1 to 3) while `run` holds; the last stage when it may not move. */
export function useHeroLoop(run: boolean, reduced: boolean): number {
  const [stage, setStage] = useState(HERO_STAGES);
  useEffect(() => {
    if (reduced || !run) {
      setStage(HERO_STAGES);
      return;
    }
    const startedAt = performance.now();
    setStage(heroStage(0));
    const timer = window.setInterval(() => setStage(heroStage(performance.now() - startedAt)), HERO_LOOP_MS / 20);
    return () => window.clearInterval(timer);
  }, [run, reduced]);
  return stage;
}
