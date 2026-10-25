// Simulador de teléfono (`/app/simulator`, docs/design-brief.md §9, ADR-0002, FL-101): the phone of the
// world's 41 synthetic personas while WhatsApp runs simulated. It opens Valeria (the main story) unless
// the user picks another persona; "Mandar mensaje del guion" sends the persona's next script line (and
// its synthetic receipt); writing, tapping a button, attaching a receipt or a test image and marking as
// read go through the BFF (`simulator.*`), which builds the same signed envelope as a real WhatsApp
// event. The thread is read again every 3 s while the agent writes ("El agente está escribiendo…") or
// right after an action, and every 15 s otherwise. "EN" shows the English gloss of every fixed text.
import { useCallback, useEffect, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import type { ApiError } from "../../lib/api-error";
import { dataOf, useAction, useRemote, useRemoteInput } from "../../lib/use-remote";
import { usePoll } from "../clock/use-poll";
import { Composer, ScriptPanel } from "./Composer";
import { simulatorCopy } from "./copy";
import { PersonaList } from "./PersonaList";
import { Phone } from "./Phone";
import { type PersonasAnswer, type SendAnswer, type SimulatorAction, type ThreadAnswer, fetchPersonas, fetchThread, runSimulatorAction } from "./simulator-api";
import { nextScriptIndex, scriptGlossOf } from "./simulator-model";

const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 15_000;
const MAIN_PERSONA = "C01";
const LIVE_MODE_REASON = "WHATSAPP_LIVE";

type Done = keyof typeof simulatorCopy.done;
const DONE_OF: Readonly<Record<SimulatorAction["kind"], Done>> = {
  sendText: "sent",
  sendScript: "sent",
  tapButton: "tapped",
  attachScriptReceipt: "attached",
  uploadReceipt: "attached",
  markRead: "read",
};

function Refusal({ error }: { readonly error: ApiError }) {
  const text = error.reason === null ? undefined : simulatorCopy.refusals[error.reason];
  return text === undefined ? <ApiErrorNotice error={error} /> : <Callout tone="warning" title={text} />;
}

function Outcome({ kind, answer }: { readonly kind: Done; readonly answer: SendAnswer | undefined }) {
  if (answer !== undefined && !answer.accepted) {
    const why = answer.reason === null ? simulatorCopy.rejectedOther : (simulatorCopy.rejections[answer.reason] ?? simulatorCopy.rejectedOther);
    return <Callout tone="warning" title={`${simulatorCopy.done.rejected}${why}`} />;
  }
  return <Callout tone="success" title={simulatorCopy.done[kind]} />;
}

function Simulator({ data }: { readonly data: PersonasAnswer }) {
  const { trpc } = useSession();
  const [chosen, setChosen] = useState(MAIN_PERSONA);
  const [english, setEnglish] = useState(false);
  const [last, setLast] = useState<{ kind: Done; answer: SendAnswer | undefined } | undefined>(undefined);
  // Right after an action the agent's turn starts: read the thread fast for a minute.
  const [recent, setRecent] = useState(0);
  useEffect(() => {
    if (recent === 0) return;
    const timer = window.setTimeout(() => setRecent(0), 60_000);
    return () => window.clearTimeout(timer);
  }, [recent]);
  const personaRef = chosen === "UNLINKED" || data.personas.some((persona) => persona.persona === chosen) ? chosen : (data.personas[0]?.persona ?? "UNLINKED");
  const persona = data.personas.find((candidate) => candidate.persona === personaRef);
  const thread = useRemoteInput<string, ThreadAnswer>("simulator.threads", persona === undefined ? undefined : persona.persona, (input, signal) => fetchThread(trpc, input, signal));
  const threadData = dataOf(thread.state);
  const fast = threadData?.typing === true || recent !== 0;
  usePoll(thread.reload, persona === undefined ? null : fast ? FAST_POLL_MS : SLOW_POLL_MS);
  const scriptGloss = scriptGlossOf(data.personas, data.unlinked);

  const action = useAction(async (request: SimulatorAction) => {
    const answer = await runSimulatorAction(trpc, request);
    setLast({ kind: DONE_OF[request.kind], answer });
    setRecent((value) => value + 1);
    thread.reload();
    return answer ?? true;
  });
  const { run } = action;
  const act = useCallback(
    (request: SimulatorAction) => {
      setLast(undefined);
      return run(request);
    },
    [run],
  );
  const busy = action.state.status === "running";

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <PersonaList data={data} current={personaRef} english={english} onOpen={setChosen} />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex justify-end">
          <button type="button" aria-pressed={english} title={simulatorCopy.gloss.toggleLabel} aria-label={simulatorCopy.gloss.toggleLabel} className={`min-h-11 min-w-11 rounded-md border px-3 text-sm font-bold ${english ? "border-pine bg-pine text-white" : "border-mist bg-white text-pine"}`} onClick={() => setEnglish((value) => !value)}>
            {simulatorCopy.gloss.toggle}
          </button>
        </div>
        <Phone
          name={persona?.name ?? simulatorCopy.personas.unlinked}
          phoneMasked={persona?.phoneMasked ?? data.unlinked.phoneMasked}
          messages={threadData?.messages ?? []}
          typing={threadData?.typing ?? false}
          english={english}
          scriptGloss={scriptGloss}
          busy={busy}
          onTap={(message, buttonIndex) => void act({ kind: "tapButton", persona: personaRef, messageId: message.messageId, buttonIndex })}
        >
          {persona !== undefined ? <ScriptPanel persona={persona} next={nextScriptIndex(persona, threadData?.messages ?? [])} english={english} busy={busy} act={act} /> : null}
          <Composer persona={persona} personaRef={personaRef} english={english} busy={busy} act={act} />
        </Phone>
        {persona === undefined ? <p className="text-sm text-slate">{simulatorCopy.unlinkedNote}</p> : null}
        {thread.state.status === "error" ? <Refusal error={thread.state.error} /> : null}
        {action.state.status === "error" ? <Refusal error={action.state.error} /> : last !== undefined ? <Outcome kind={last.kind} answer={last.answer} /> : null}
      </div>
    </div>
  );
}

export function SimulatorView() {
  const { trpc } = useSession();
  const personas = useRemote<PersonasAnswer>("simulator.personas", (signal) => fetchPersonas(trpc, signal));
  const view = consoleCopy.views.simulator;
  const live = personas.state.status === "error" && personas.state.error.reason === LIVE_MODE_REASON;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <p className="mb-6 max-w-3xl text-sm text-slate">{simulatorCopy.lead}</p>
      {live ? (
        <Callout tone="warning" title={simulatorCopy.liveMode} />
      ) : (
        <RemoteBlock state={personas.state} onRetry={personas.reload}>
          {(data) => <Simulator data={data} />}
        </RemoteBlock>
      )}
    </div>
  );
}
