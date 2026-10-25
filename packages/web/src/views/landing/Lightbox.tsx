// Viewer of the landing gallery: a native <dialog> (Escape, focus and the backdrop come from the
// browser) showing one picture at up to the size of the viewport. Previous and next by the arrow
// buttons, the ← and → keys or a horizontal swipe; a click outside the picture, the close button or
// Escape closes it. No library and no inline script (the console CSP forbids it).
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { GalleryItem } from "./media";
import { useLandingCopy } from "./lang";
import { Picture } from "./Picture";

interface LightboxProps {
  readonly items: readonly GalleryItem[];
  readonly index: number | undefined;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
}

const SWIPE_PX = 48;
const NAV =
  "absolute top-1/2 -translate-y-1/2 rounded-full bg-white/90 px-3 py-2 text-lg font-semibold text-pine shadow-card hover:bg-white disabled:opacity-30";

export function Lightbox({ items, index, onIndex, onClose }: LightboxProps) {
  const landingCopy = useLandingCopy();
  const dialog = useRef<HTMLDialogElement>(null);
  const swipeFrom = useRef<number | undefined>(undefined);
  const item = index === undefined ? undefined : items[index];
  const open = item !== undefined;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const step = (delta: number) => {
    if (index === undefined || items.length === 0) return;
    onIndex((index + delta + items.length) % items.length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "ArrowRight") step(1);
    if (event.key === "ArrowLeft") step(-1);
    // Handled here too: the dialog's own Escape only closes it for trusted key presses.
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  // Swipes are for touch; a mouse drag over the picture must not also count as a click.
  const onPointerDown = (event: PointerEvent) => {
    swipeFrom.current = event.pointerType === "mouse" ? undefined : event.clientX;
  };
  const onPointerUp = (event: PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = undefined;
    if (from === undefined) return;
    const delta = event.clientX - from;
    if (Math.abs(delta) >= SWIPE_PX) step(delta < 0 ? 1 : -1);
  };
  const stop = (event: { stopPropagation: () => void }) =>
    event.stopPropagation();

  return (
    <dialog
      ref={dialog}
      aria-label={item?.alt ?? landingCopy.zoom.open}
      onClose={onClose}
      onClick={onClose}
      onKeyDown={onKeyDown}
      className="m-auto max-h-none max-w-none bg-transparent p-0 backdrop:bg-pine-deep/90"
    >
      {item ? (
        <div className="relative flex h-dvh w-dvw flex-col items-center justify-center gap-3 px-14 py-12 sm:px-20">
          <div onClick={stop} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onDragStart={(event) => event.preventDefault()} className="flex min-h-0 w-full flex-1 touch-pan-y select-none items-center justify-center">
            <Picture
              desktop={item.desktop}
              mobile={item.mobile}
              alt={item.alt}
              sizes="100vw"
              eager
              className="contents"
              imgClassName="max-h-full w-auto max-w-full rounded-card object-contain shadow-card"
            />
          </div>
          <p
            onClick={stop}
            className="max-w-3xl text-center text-sm text-white"
          >
            {item.alt}{" "}
            <span className="ml-2 text-mist">
              {landingCopy.zoom.counter((index ?? 0) + 1, items.length)}
            </span>
          </p>
          {items.length > 1 ? (
            <>
              <button
                type="button"
                aria-label={landingCopy.zoom.previous}
                onClick={(event) => (stop(event), step(-1))}
                className={`${NAV} left-3`}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label={landingCopy.zoom.next}
                onClick={(event) => (stop(event), step(1))}
                className={`${NAV} right-3`}
              >
                ›
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-label={landingCopy.zoom.close}
            title={landingCopy.zoom.close}
            onClick={onClose}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-pine shadow-card hover:bg-white"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ) : null}
    </dialog>
  );
}
