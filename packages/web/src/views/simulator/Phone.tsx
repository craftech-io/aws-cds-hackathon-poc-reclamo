// The simulated phone of one persona: a generic chat skin that always says "WhatsApp (simulado)", the
// thread as the phone shows it (the persona's own messages on the right, Jarilla's on the left with its
// template label, reply buttons and images), "El agente está escribiendo…" while an event of the
// customer is in flight, the English gloss under each message with "EN", and the ticks.
import { formatSimInstant } from "@reclamo/shared";
import { type ReactNode, useEffect, useRef } from "react";
import { simulatorCopy } from "./copy";
import type { SimMessage } from "./simulator-api";
import { type Gloss, chronological, glossOf, noteArrivals, ticksOf } from "./simulator-model";

const copy = simulatorCopy.phone;

function GlossBlock({ gloss }: { readonly gloss: Gloss }) {
  if (gloss.lines.length === 0 && gloss.buttons.length === 0) return null;
  return (
    <div lang="en" className="mt-1 rounded bg-info-soft px-2 py-1 text-xs text-info italic">
      {gloss.lines.map((line, index) => (
        <p key={`${index}-${line ?? ""}`}>{line ?? simulatorCopy.gloss.agentText}</p>
      ))}
      {gloss.buttons.length > 0 ? <p className="mt-1">{gloss.buttons.map((title) => `[${title}]`).join(" ")}</p> : null}
    </div>
  );
}

interface BubbleProps {
  readonly message: SimMessage;
  readonly english: boolean;
  readonly scriptGloss: ReadonlyMap<string, string>;
  readonly tapping: boolean;
  readonly onTap: (message: SimMessage, buttonIndex: number) => void;
}

function Bubble({ message, english, scriptGloss, tapping, onTap }: BubbleProps) {
  const own = message.direction === "IN";
  const ticks = ticksOf(message);
  const statusText = copy.status[message.status] ?? message.status;
  return (
    <li className={`flex ${own ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-72 overflow-hidden rounded-lg shadow-card ${own ? "bg-success-soft" : "bg-white"}`}>
        <div className="px-3 pt-2 pb-1">
          {message.templateName !== null ? <p className="mb-1 text-xs font-semibold text-slate uppercase">{copy.template}</p> : null}
          {message.image !== null ? (
            <p className="mb-1 rounded bg-paper px-2 py-1 text-xs text-pine">
              {copy.image}
              {message.image.scan ? ` · ${copy.scan(message.image.scan)}` : ""}
            </p>
          ) : null}
          {message.body ? <p className="text-sm break-words whitespace-pre-wrap text-ink">{message.body}</p> : null}
          {english ? <GlossBlock gloss={glossOf(message, scriptGloss)} /> : null}
          <p className="mt-1 flex items-center justify-end gap-1 text-xs text-slate">
            <time dateTime={message.atSim}>{formatSimInstant(message.atSim)}</time>
            {ticks ? (
              <span title={statusText} aria-label={statusText} className={ticks.read ? "font-bold text-info" : ""}>
                {ticks.symbol}
              </span>
            ) : null}
          </p>
        </div>
        {!own && message.buttons.length > 0 ? (
          <div>
            {message.buttons.map((button) => (
              <button
                key={`${button.index}-${button.action}`}
                type="button"
                disabled={tapping}
                aria-label={copy.tap(button.title)}
                className="block min-h-11 w-full border-t border-mist px-3 py-2 text-center text-sm font-semibold text-seal-deep hover:bg-paper disabled:opacity-50"
                onClick={() => onTap(message, button.index)}
              >
                {button.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

interface PhoneProps {
  readonly name: string;
  readonly phoneMasked: string;
  readonly messages: readonly SimMessage[];
  readonly typing: boolean;
  readonly english: boolean;
  readonly scriptGloss: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly onTap: (message: SimMessage, buttonIndex: number) => void;
  /** The composer and the script panel, under the chat. */
  readonly children: ReactNode;
}

export function Phone({ name, phoneMasked, messages, typing, english, scriptGloss, busy, onTap, children }: PhoneProps) {
  // Order of arrival on this page: the thread carries no stored instant to order a paused minute by.
  const arrivals = useRef(new Map<string, number>());
  noteArrivals(arrivals.current, messages);
  const ordered = chronological(messages, arrivals.current);
  const chat = useRef<HTMLDivElement>(null);
  // The newest message stays in sight, as on a phone.
  useEffect(() => {
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [ordered.length, typing]);
  return (
    <section aria-label={copy.title(name)} className="mx-auto w-full max-w-md overflow-hidden rounded-3xl border-8 border-pine-deep bg-mist shadow-card">
      <header className="bg-pine px-4 py-3 text-white">
        <p className="text-xs font-semibold tracking-wide text-seal-soft uppercase">
          {simulatorCopy.frameLabel}
          {english ? <span lang="en"> · {simulatorCopy.frameLabelEn}</span> : null}
        </p>
        <p className="mt-1 font-semibold">{name}</p>
        <p className="font-mono text-xs text-mist">{phoneMasked}</p>
      </header>
      <div ref={chat} className="flex h-128 flex-col gap-2 overflow-y-auto px-3 py-4" aria-live="polite">
        {ordered.length === 0 ? <p className="text-center text-sm text-slate">{copy.empty}</p> : null}
        <ul className="flex flex-col gap-2">
          {ordered.map((message) => (
            <Bubble key={message.messageId} message={message} english={english} scriptGloss={scriptGloss} tapping={busy} onTap={onTap} />
          ))}
        </ul>
        {typing ? (
          <p role="status" className="self-start rounded-lg bg-white px-3 py-2 text-sm text-slate italic shadow-card">
            {copy.typing}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
