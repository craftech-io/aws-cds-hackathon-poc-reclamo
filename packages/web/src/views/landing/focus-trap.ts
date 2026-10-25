// Keeps the keyboard inside an open dialog (docs/landing-spec.md §5, checklist §10 #4): on open the
// focus moves to the dialog's first focusable element and Tab / Shift+Tab cycle inside it. Closing
// and giving the focus back to the opener is the caller's (it knows the opener). Used on the shared
// `Drawer`, which closes on Escape and on its backdrop by itself, from the element inside it.
import { type RefObject, useEffect } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The element of the next Tab press, or `undefined` to let the browser move as usual. */
export function nextFocus(focusable: readonly HTMLElement[], current: Element | null, backwards: boolean): HTMLElement | undefined {
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return undefined;
  const inside = current !== null && focusable.includes(current as HTMLElement);
  if (!inside) return backwards ? last : first;
  if (backwards && current === first) return last;
  if (!backwards && current === last) return first;
  return undefined;
}

/** Traps the focus in the closest `[role="dialog"]` around `anchor` while `active` holds. */
export function useFocusTrap(anchor: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const dialog = anchor.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const target = nextFocus(focusable(), document.activeElement, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [anchor, active]);
}
