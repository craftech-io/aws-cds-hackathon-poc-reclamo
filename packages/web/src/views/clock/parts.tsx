// Pieces the demo clock shares with the guided tour: a refusal of the BFF in words (the clock's own
// reasons from copy.ts, the console's generic texts otherwise) and the busy state of the world with
// "Avanzar igual" once the BFF accepts it.
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import type { ApiError } from "../../lib/api-error";
import type { ClockAnswer } from "./clock-api";
import { busyText, forceAllowed, realClockText } from "./clock-model";
import { clockCopy } from "./copy";

/** A refusal of a clock move: its reason in words when the clock knows it. */
export function ClockRefusal({ error }: { readonly error: ApiError }) {
  const text = error.reason === null ? undefined : clockCopy.refusals[error.reason];
  if (text === undefined) return <ApiErrorNotice error={error} />;
  return <Callout tone="warning" title={text} />;
}

interface BusyNoticeProps {
  readonly busy: NonNullable<ClockAnswer["busy"]>;
  readonly nowMs: number;
  /** Shown once the BFF accepts `force`; absent where a forced move makes no sense. */
  readonly onForce?: () => void;
  readonly disabled?: boolean;
}

/** Why the world is busy and what it waits for; "Avanzar igual" once the oldest item waited 5 minutes. */
export function BusyNotice({ busy, nowMs, onForce, disabled = false }: BusyNoticeProps) {
  const canForce = forceAllowed(busy, nowMs);
  return (
    <Callout
      tone="warning"
      title={clockCopy.busy.title}
      action={
        onForce !== undefined && canForce ? (
          <Button variant="secondary" disabled={disabled} onClick={onForce}>
            {clockCopy.busy.force}
          </Button>
        ) : undefined
      }
    >
      <p>
        {busyText(busy.reason)} · {clockCopy.busy.pending(busy.pending.length)}
      </p>
      <p className="mt-1 text-slate">{canForce ? clockCopy.busy.lead : clockCopy.busy.forceAt(realClockText(busy.forceAllowedAtReal))}</p>
    </Callout>
  );
}
