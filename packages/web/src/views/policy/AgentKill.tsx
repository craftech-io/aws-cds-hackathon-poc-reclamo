// The agent cut-off of the `demo` world (ADR-0017; docs/design-brief.md §9): every role reads whether
// the agent is cut; a SUPERVISOR of `demo` turns it on or off (`policy.setAgentKill`, recent sign-in,
// audited). Two steps, so a cut that stops the agent in every world is never one stray click; with an
// old sign-in the step-up opens in place before anything is sent.
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { signInIsRecent } from "../../lib/session";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useAction } from "../../lib/use-remote";
import { policyCopy } from "./copy";
import { type PolicyModes, canCutAgent, killStateOf } from "./policy-model";

const copy = policyCopy.kill;

interface KillInput {
  readonly on: boolean;
  readonly reason?: string;
}

function Controls({ cut, onChanged }: { readonly cut: boolean; readonly onChanged: () => void }) {
  const { trpc, openPrompt } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const action = useAction<KillInput, RouterOutputs["policy"]["setAgentKill"]>((input) => trpc.policy.setAgentKill.mutate(input));
  const apply = () => {
    if (!signInIsRecent(Date.now())) {
      setNeedsStepUp(true);
      openPrompt("stepUp");
      return;
    }
    setNeedsStepUp(false);
    const trimmed = reason.trim();
    void action.run({ on: !cut, ...(trimmed === "" ? {} : { reason: trimmed }) }).then((result) => {
      if (result === undefined) return;
      setConfirming(false);
      setReason("");
      onChanged();
    });
  };
  return (
    <div className="space-y-3">
      {!confirming ? (
        <Button variant={cut ? "secondary" : "danger"} onClick={() => setConfirming(true)}>
          {cut ? copy.lift : copy.cut}
        </Button>
      ) : (
        <div className="space-y-3 rounded-md border border-mist bg-paper p-3">
          <label className={LABEL_CLASS}>
            {copy.reason}
            <input className={FIELD_CLASS} value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant={cut ? "primary" : "danger"} onClick={apply} disabled={action.state.status === "running"}>
              {action.state.status === "running" ? copy.running : cut ? copy.confirmLift : copy.confirmCut}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      )}
      {needsStepUp ? <Callout tone="warning">{copy.recent}</Callout> : null}
      {action.state.status === "error" ? <ApiErrorNotice error={action.state.error} /> : null}
      {action.state.status === "done" ? <Callout tone="success">{action.state.data.killed ? copy.doneOn : copy.doneOff}</Callout> : null}
    </div>
  );
}

export function AgentKill({ modes, onChanged }: { readonly modes: PolicyModes; readonly onChanged: () => void }) {
  const principal = usePrincipal();
  const state = killStateOf(modes);
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-slate">{copy.lead}</p>
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={state.cut ? "danger" : "success"}>{state.text}</Badge>
        {modes.agentKill.world ? <span className="text-xs text-slate">{copy.worldCut}</span> : null}
      </p>
      {canCutAgent(principal) ? <Controls cut={state.cut} onChanged={onChanged} /> : <p className="text-xs text-slate">{copy.onlySupervisor}</p>}
    </div>
  );
}
