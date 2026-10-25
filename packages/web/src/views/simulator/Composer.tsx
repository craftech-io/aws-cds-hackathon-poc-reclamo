// The bottom of the simulated phone: the persona's script ("Mandar mensaje del guion", the next line not
// sent yet, with its synthetic receipt when it has one), a free text as the persona, and the attachments —
// the persona's synthetic receipt or a test image of the user's (checked here for type and size before
// the presigned POST, under the fixed notice: only synthetic or test receipts, never real documents).
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { simulatorCopy } from "./copy";
import type { SimPersona, SimulatorAction } from "./simulator-api";
import { imageProblem } from "./simulator-model";

const copy = simulatorCopy;

interface ScriptPanelProps {
  readonly persona: SimPersona;
  readonly next: number | undefined;
  readonly english: boolean;
  readonly busy: boolean;
  readonly act: (action: SimulatorAction) => Promise<unknown>;
}

export function ScriptPanel({ persona, next, english, busy, act }: ScriptPanelProps) {
  const line = next === undefined ? undefined : persona.script[next];
  return (
    <section aria-label={copy.script.title} className="border-t border-mist bg-white p-3">
      <p className="text-sm font-semibold text-pine">{copy.script.title}</p>
      <ol className="mt-2 space-y-1 text-sm">
        {persona.script.map((item, index) => (
          <li key={item.text} className={index === next ? "text-ink" : "text-slate"}>
            <span className="text-xs font-semibold tracking-wide uppercase">{next !== undefined && index < next ? copy.script.sent : index === next ? copy.script.next : ""}</span> “{item.text}”
            {item.receipt ? <span className="text-xs text-slate"> ({copy.script.receipt})</span> : null}
            {english ? (
              <span lang="en" className="block text-xs text-info italic">
                {item.en}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="mt-3">
        {line === undefined ? (
          <p className="text-xs text-slate">{copy.script.allSent}</p>
        ) : (
          <Button disabled={busy} onClick={() => void act({ kind: "sendScript", persona: persona.persona, text: line.text, receipt: line.receipt })}>
            {line.receipt ? copy.script.sendWithReceipt : copy.script.send}
          </Button>
        )}
      </div>
    </section>
  );
}

interface AttachPanelProps {
  readonly persona: SimPersona;
  readonly english: boolean;
  readonly busy: boolean;
  readonly act: (action: SimulatorAction) => Promise<unknown>;
}

function AttachPanel({ persona, english, busy, act }: AttachPanelProps) {
  const [file, setFile] = useState<File | undefined>(undefined);
  const fileId = useId();
  const noticeId = `${fileId}-notice`;
  const problem = file === undefined ? undefined : imageProblem(file);
  return (
    <section aria-label={copy.attach.title} className="flex flex-col gap-3 border-t border-mist bg-white p-3">
      <p className="text-sm font-semibold text-pine">{copy.attach.synthetic}</p>
      {persona.hasReceipt ? (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void act({ kind: "attachScriptReceipt", persona: persona.persona })}>
            {copy.attach.sendSynthetic}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-slate">{copy.attach.noSynthetic}</p>
      )}
      <p id={noticeId} role="note" className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs text-ink">
        {copy.attach.notice}
        {english ? (
          <span lang="en" className="block text-info italic">
            {copy.attach.noticeEn}
          </span>
        ) : null}
      </p>
      <label htmlFor={fileId} className={LABEL_CLASS}>
        {copy.attach.own}
        <input id={fileId} type="file" accept="image/jpeg,image/png" aria-describedby={noticeId} className={FIELD_CLASS} onChange={(event) => setFile(event.target.files?.[0])} />
      </label>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {copy.attach[problem]}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={busy || file === undefined || problem !== undefined} onClick={() => file && void act({ kind: "uploadReceipt", persona: persona.persona, file })}>
          {copy.attach.sendOwn}
        </Button>
        <span className="text-xs text-slate">{copy.attach.scanning}</span>
      </div>
    </section>
  );
}

interface ComposerProps {
  /** Undefined for the unlinked number, which only writes. */
  readonly persona: SimPersona | undefined;
  readonly personaRef: string;
  readonly english: boolean;
  readonly busy: boolean;
  readonly act: (action: SimulatorAction) => Promise<unknown>;
}

export function Composer({ persona, personaRef, english, busy, act }: ComposerProps) {
  const [text, setText] = useState("");
  const [attaching, setAttaching] = useState(false);
  const inputId = useId();
  const send = async () => {
    const value = text.trim();
    if (value === "") return;
    const result = await act({ kind: "sendText", persona: personaRef, text: value });
    if (result !== undefined) setText("");
  };
  return (
    <div>
      {persona !== undefined ? (
        <div className="flex justify-start border-t border-mist bg-paper px-2 pt-2">
          <Button variant="ghost" aria-pressed={attaching} onClick={() => setAttaching((value) => !value)}>
            {attaching ? copy.composer.closeAttach : copy.composer.attach}
          </Button>
        </div>
      ) : null}
      {attaching && persona !== undefined ? <AttachPanel persona={persona} english={english} busy={busy} act={act} /> : null}
      <form
        className="flex items-center gap-2 border-t border-mist bg-paper p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {copy.composer.label}
        </label>
        <input id={inputId} className={`${FIELD_CLASS} min-w-0 flex-1`} value={text} maxLength={1_000} placeholder={copy.composer.placeholder} autoComplete="off" onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={busy || text.trim() === ""}>
          {copy.composer.send}
        </Button>
      </form>
    </div>
  );
}
