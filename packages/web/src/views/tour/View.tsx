// Recorrido guiado (`/app/tour`, docs/design-brief.md §15, FL-101): the guest's tour in Spanish or
// English, from steps.ts. Before step 1 it checks that the world is pristine (clock on Wed 07/10 10:10,
// paused, and no complaint of Valeria yet) and otherwise offers to reset it or to use another account; it
// is the same for a self-signup account whose world is `READY` and for `guest-NN`. "Tu recorrido: ~X min"
// counts the budgets of what is left in the current block. A `run` button goes through `tour.run` (the
// gates of the same click in its view); an `open` button navigates to the view. The progress is kept per
// world and epoch, so a reset — which the shell covers with "Estamos reiniciando tu mundo" until
// `READY` — starts the tour over, checking the world again.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { useRouter } from "../../lib/router";
import { dataOf, useAction, useRemote } from "../../lib/use-remote";
import { type ClockAnswer, fetchClock } from "../clock/clock-api";
import { busyText } from "../clock/clock-model";
import { ClockRefusal } from "../clock/parts";
import { usePoll } from "../clock/use-poll";
import { TOUR_LANG_KEY, TOUR_TEXTS } from "./copy";
import { MAIN_STORY, PERSONA_NAMES, TOUR_STEPS, type TourLang, type TourPersona, type TourStep, formatTourInstant } from "./steps";
import { StepCard } from "./StepCard";
import { MissingComplaintError, TourStepsAnswer, personaComplaint, runTourAction } from "./tour-api";
import { type TourProgress, blockTitle, currentStep, factValues, loadProgress, progressKey, remainingMinutes, remainingSeconds, saveProgress, stepComplete, targetPath, withMove, withStepDone } from "./tour-model";

const POLL_MS = 3_000;

function storedLang(): TourLang {
  try {
    return window.localStorage.getItem(TOUR_LANG_KEY) === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

function LangSwitch({ lang, onChange }: { readonly lang: TourLang; readonly onChange: (lang: TourLang) => void }) {
  return (
    <div role="group" aria-label={TOUR_TEXTS[lang].langLabel} className="flex rounded-md border border-mist bg-white p-0.5">
      {(["es", "en"] as const).map((option) => (
        <button key={option} type="button" aria-pressed={lang === option} className={`min-h-11 min-w-11 rounded px-3 text-sm font-semibold ${lang === option ? "bg-pine text-white" : "text-pine hover:bg-paper"}`} onClick={() => onChange(option)}>
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function PristineCheck({ world, lang, onReset, resetting }: { readonly world: TourStepsAnswer; readonly lang: TourLang; readonly onReset: () => void; readonly resetting: boolean }) {
  const texts = TOUR_TEXTS[lang];
  const [confirming, setConfirming] = useState(false);
  if (world.pristine.ok) return <Callout tone="success" title={texts.pristineOk(formatTourInstant(world.startAtSim, lang, "time"))} />;
  const confirm = (
    <>
      <Button variant="danger" disabled={resetting} onClick={onReset}>
        {texts.resetConfirm}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        {texts.cancel}
      </Button>
    </>
  );
  return (
    <Callout tone="warning" title={texts.pristineTitle} action={confirming ? confirm : <Button variant="secondary" onClick={() => setConfirming(true)}>{texts.resetAsk}</Button>}>
      {world.pristine.clockAtStart ? null : <p>{texts.pristineClock(formatTourInstant(world.simNow, lang, "time"))}</p>}
      {world.pristine.mainStoryFiled ? <p>{texts.pristineFiled(world.mainStory?.complaintNumber ?? MAIN_STORY.number)}</p> : null}
      <p className="mt-1">{texts.pristineWays}</p>
    </Callout>
  );
}

interface TourProps {
  readonly world: TourStepsAnswer;
  readonly clock: ClockAnswer | undefined;
  readonly lang: TourLang;
  readonly reload: () => void;
}

function Tour({ world, clock, lang, reload }: TourProps) {
  const { trpc } = useSession();
  const { navigate } = useRouter();
  const texts = TOUR_TEXTS[lang];
  const key = clock === undefined ? undefined : progressKey(world.worldId, clock.worldEpoch);
  const [progress, setProgress] = useState<TourProgress>(new Set());
  const [running, setRunning] = useState<{ step: string; index: number } | undefined>(undefined);
  const [missing, setMissing] = useState<TourPersona | undefined>(undefined);
  useEffect(() => {
    if (key !== undefined) setProgress(loadProgress(window.sessionStorage, key));
  }, [key]);
  const update = useCallback(
    (next: TourProgress) => {
      setProgress(next);
      if (key !== undefined) saveProgress(window.sessionStorage, key, next);
    },
    [key],
  );
  const action = useAction(async ({ step, index }: { step: TourStep; index: number }): Promise<{ readonly missing?: TourPersona }> => {
    const move = step.moves[index];
    if (move === undefined) return {};
    try {
      if (move.kind === "run") {
        await runTourAction(trpc, move.action);
        return {};
      }
      const complaint = move.target.view === "complaint" ? await personaComplaint(trpc, move.target.persona) : undefined;
      if (move.target.view === "complaint" && complaint === undefined) return { missing: move.target.persona };
      const path = targetPath(move.target, complaint?.complaintId);
      if (path !== undefined) navigate(path);
      return {};
    } catch (error) {
      if (error instanceof MissingComplaintError) return { missing: error.persona };
      throw error;
    }
  });
  const reset = useAction(() => trpc.clock.reset.mutate());

  const onMove = (step: TourStep, index: number) => {
    setMissing(undefined);
    setRunning({ step: step.id, index });
    void action.run({ step, index }).then((outcome) => {
      setRunning(undefined);
      if (outcome?.missing !== undefined) setMissing(outcome.missing);
      else if (outcome !== undefined) update(withMove(progress, step, index));
      reload();
    });
  };

  const current = currentStep(TOUR_STEPS, progress);
  const left = remainingSeconds(TOUR_STEPS, progress);
  const busyReason = clock?.busy === null || clock?.busy === undefined ? undefined : busyText(clock.busy.reason, lang);
  const failure = reset.state.status === "error" ? reset.state.error : action.state.status === "error" ? action.state.error : undefined;

  return (
    <div className="space-y-6">
      <p className="text-base font-semibold text-pine" role="status">
        {current === undefined ? texts.finished : texts.yourTour(remainingMinutes(left.seconds))}
      </p>
      <PristineCheck world={world} lang={lang} resetting={reset.state.status === "running"} onReset={() => void reset.run(undefined).then(reload)} />
      {failure ? failure.reason !== null && texts.refusals[failure.reason] !== undefined ? <Callout tone="warning" title={texts.refusals[failure.reason]} /> : <ClockRefusal error={failure} /> : null}
      {missing === undefined ? null : <Callout tone="warning" title={texts.missingComplaint(PERSONA_NAMES[missing])} />}
      {(["QUICK", "DEEP"] as const).map((block) => (
        <section key={block} aria-labelledby={`tour-block-${block}`}>
          <h2 id={`tour-block-${block}`} className="mb-3 text-lg font-semibold text-pine">
            {blockTitle(block, lang)}
          </h2>
          <ol className="space-y-3">
            {TOUR_STEPS.filter((step) => step.block === block).map((step) => (
              <StepCard
                key={step.id}
                step={step}
                lang={lang}
                state={step === current ? "current" : stepComplete(step, progress) ? "done" : "upcoming"}
                progress={progress}
                values={factValues(step, world)}
                busyReason={busyReason}
                running={running?.step === step.id ? running.index : undefined}
                onMove={(index) => onMove(step, index)}
                onMarkDone={() => update(withStepDone(progress, step))}
              />
            ))}
          </ol>
        </section>
      ))}
      <Button variant="ghost" onClick={() => update(new Set())}>
        {texts.startOver}
      </Button>
    </div>
  );
}

export function TourView() {
  const { trpc } = useSession();
  const [lang, setLang] = useState<TourLang>(storedLang);
  const steps = useRemote<TourStepsAnswer>("tour.steps", async (signal) => TourStepsAnswer.parse(await trpc.tour.steps.query(undefined, { signal })));
  const clock = useRemote<ClockAnswer>("tour.clock", (signal) => fetchClock(trpc, signal));
  const clockData = dataOf(clock.state);
  const { reload: reloadSteps } = steps;
  const { reload: reloadClock } = clock;
  const reload = useCallback(() => {
    reloadSteps();
    reloadClock();
  }, [reloadSteps, reloadClock]);
  usePoll(reload, clockData !== undefined && (clockData.busy !== null || clockData.mode === "RUNNING") ? POLL_MS : null);
  const chooseLang = (next: TourLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(TOUR_LANG_KEY, next);
    } catch {
      // The language is a convenience; the panel works without remembering it.
    }
  };
  const view = consoleCopy.views.tour;
  return (
    <div>
      <PageHeader title={view.title} description={TOUR_TEXTS[lang].lead} actions={<LangSwitch lang={lang} onChange={chooseLang} />} />
      <RemoteBlock state={steps.state} onRetry={steps.reload}>
        {(world) => <Tour world={world} clock={clockData} lang={lang} reload={reload} />}
      </RemoteBlock>
    </div>
  );
}
