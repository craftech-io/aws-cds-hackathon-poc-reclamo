// What the gate did with a message a person sent from the console (FL-064, FL-065, FL-066, FL-067,
// FL-085). The console only enqueued it: this panel reads the compliance tape every 1.5 s until the
// decision is there, shows it (a block in red, with its English gloss) and, under a block that has a
// permitted path, offers it: "Derivar a la cola humana" or "Enviar aviso formal por email", decided
// by `conversation.reroute` from the tape, never from what the browser says.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Reroute } from "@reclamo/shared";
import { REROUTE_GLOSS, REROUTE_LABEL } from "@reclamo/bff/copy/index";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { useSession } from "../../context/SessionContext";
import { type ApiError, apiErrorOf, isAbortError } from "../../lib/api-error";
import { useAction } from "../../lib/use-remote";
import { customerCopy } from "./copy";
import { type TapeEntryView, offeredRoutes, openBlockOf, trailOf, trailStatus } from "./gate-model";
import { TapeBanner } from "./TapeBanner";

/** How often the tape is read while the decision is not there, and for how long (about a minute). */
export const TRAIL_POLL_MS = 1_500;
const MAX_POLLS = 40;
/** Newest entries read per poll: the message is among the last decisions of the world. */
const TAPE_WINDOW = 100;

interface GateTrailProps {
  readonly messageId: string;
  readonly customerId: string;
  /** After the trail settles or a reroute is picked: the host reads its data again. */
  readonly onChange?: () => void;
}

export function GateTrail({ messageId, customerId, onChange }: GateTrailProps) {
  const { trpc } = useSession();
  const [entries, setEntries] = useState<readonly TapeEntryView[]>([]);
  const [polls, setPolls] = useState(0);
  const [failure, setFailure] = useState<ApiError | undefined>(undefined);
  const [chosen, setChosen] = useState(false);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  const trail = trailOf(entries, messageId);
  const block = openBlockOf(trail);
  const read = trailStatus(trail);
  // Once a path was picked, the open block is only waiting for its `REROUTED` to land.
  const status = chosen && read === "NEEDS_CHOICE" ? "WAITING" : read;
  const polling = status === "WAITING" && polls < MAX_POLLS && failure === undefined;

  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        trpc.tape.list.query({ limit: TAPE_WINDOW }, { signal: controller.signal }).then(
          (answer) => {
            setEntries(answer.entries);
            setPolls((count) => count + 1);
          },
          (error: unknown) => {
            if (!isAbortError(error)) setFailure(apiErrorOf(error));
          },
        );
      },
      polls === 0 ? 0 : TRAIL_POLL_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [polling, polls, trpc]);

  const settled = status === "SETTLED";
  useEffect(() => {
    if (settled) onChangeRef.current?.();
  }, [settled]);

  const reroute = useAction(async (route: Reroute) => {
    if (!block) throw new Error("no open block");
    const answer = await trpc.conversation.reroute.mutate({ tapeId: block.tapeId, route, customerId });
    setChosen(true);
    setPolls(0);
    onChangeRef.current?.();
    return answer;
  });

  const routes = block ? offeredRoutes(block) : [];
  const humanQueued = trail.some((entry) => entry.decision === "REROUTED" && entry.reroute?.route === "HUMAN_QUEUE");

  return (
    <section aria-label={customerCopy.trail.title} className="space-y-2">
      <h3 className="text-sm font-semibold text-pine">{customerCopy.trail.title}</h3>
      {trail.map((entry) => (
        <TapeBanner key={entry.tapeId} entry={entry}>
          {entry === block && routes.length > 0 && !chosen ? (
            <>
              <p className="w-full text-xs font-semibold text-ink">{customerCopy.trail.offered}</p>
              {routes.map((route) => (
                <Button key={route} variant={route === "FORMAL_EMAIL" ? "primary" : "secondary"} disabled={reroute.state.status === "running"} onClick={() => void reroute.run(route)}>
                  {REROUTE_LABEL[route]} · {REROUTE_GLOSS[route]}
                </Button>
              ))}
            </>
          ) : null}
        </TapeBanner>
      ))}
      {humanQueued ? <Callout tone="info">{customerCopy.trail.humanQueued}</Callout> : null}
      {polling ? (
        <p role="status" className="text-xs text-slate">
          {customerCopy.trail.waiting}
        </p>
      ) : null}
      {status === "WAITING" && polls >= MAX_POLLS ? <Callout tone="warning">{customerCopy.trail.slow}</Callout> : null}
      {failure ? (
        <ApiErrorNotice
          error={failure}
          onRetry={() => {
            setFailure(undefined);
            setPolls(0);
          }}
        />
      ) : null}
      {reroute.state.status === "error" ? <ApiErrorNotice error={reroute.state.error} /> : null}
    </section>
  );
}
