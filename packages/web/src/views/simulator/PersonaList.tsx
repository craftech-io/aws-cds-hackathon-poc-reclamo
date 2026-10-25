// The 41 synthetic personas of the world (and the unlinked number), each with its scenario, searchable
// by name or scenario. Opening one shows its phone; the English of the scenario follows the "EN" switch.
import { useId, useState } from "react";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { simulatorCopy } from "./copy";
import type { PersonasAnswer } from "./simulator-api";
import { filterPersonas } from "./simulator-model";

const copy = simulatorCopy.personas;

interface PersonaListProps {
  readonly data: PersonasAnswer;
  readonly current: string;
  readonly english: boolean;
  readonly onOpen: (persona: string) => void;
}

function itemClass(active: boolean): string {
  return `block min-h-11 w-full rounded-card border px-3 py-2 text-left ${active ? "border-seal bg-seal-soft" : "border-mist bg-white hover:bg-paper"}`;
}

export function PersonaList({ data, current, english, onOpen }: PersonaListProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const shown = filterPersonas(data.personas, query);
  return (
    <nav aria-label={copy.title} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">{copy.title}</h2>
      <label htmlFor={searchId} className={LABEL_CLASS}>
        {copy.filter}
        <input id={searchId} type="search" className={FIELD_CLASS} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1 lg:max-h-160">
        {shown.map((persona) => (
          <li key={persona.persona}>
            <button type="button" aria-current={persona.persona === current ? "true" : undefined} title={copy.open(persona.name)} className={itemClass(persona.persona === current)} onClick={() => onOpen(persona.persona)}>
              <span className="block text-sm font-medium text-pine">
                {persona.persona} · {persona.name}
              </span>
              <span className="block text-xs text-slate">{english ? persona.scenarioEn : persona.scenario}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 ? <li className="text-sm text-slate">{copy.empty}</li> : null}
        <li>
          <button type="button" aria-current={current === "UNLINKED" ? "true" : undefined} className={itemClass(current === "UNLINKED")} onClick={() => onOpen("UNLINKED")}>
            <span className="block text-sm font-medium text-pine">{copy.unlinked}</span>
            <span className="block text-xs text-slate">{copy.unlinkedScenario}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
