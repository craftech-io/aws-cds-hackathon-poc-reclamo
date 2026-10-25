import { useEffect, useRef, type ReactNode } from "react";

interface DrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-hand side panel for details, forms and the console's menu on a phone: a modal dialog that
 * takes the focus, keeps Tab inside it, closes on Escape and on the backdrop and gives the focus back
 * to what had it.
 */
export function Drawer({ open, title, onClose, closeLabel, children }: DrawerProps) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      const inside = panel.current?.contains(document.activeElement) === true;
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" tabIndex={-1} aria-label={closeLabel} className="flex-1 bg-pine-deep/40" onClick={onClose} />
      <aside ref={panel} role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-lg flex-col bg-white shadow-card">
        <header className="flex items-center justify-between border-b border-mist px-6 py-4">
          <h2 className="text-lg font-semibold text-pine">{title}</h2>
          <button type="button" className="rounded-md px-2 py-1 text-sm text-slate hover:bg-mist" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </aside>
    </div>
  );
}
