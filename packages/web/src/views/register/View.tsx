// Registro (docs/design-brief.md §9; docs/architecture.md §8.3; ADR-0014; FL-096): the complaint
// register and the refund register of the world's current epoch, append-only, with the state of the
// hash chain verified against its anchors ("Verificada" · "Parcial: N entradas sin ancla" · "Rota en
// seq N") and the export that carries that verification in its header. Read-only for every role.
import { type FormEvent, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { dataOf, useRemote, useRemoteInput } from "../../lib/use-remote";
import { ChainStatus } from "./ChainStatus";
import { ExportPanel } from "./ExportPanel";
import { RegisterTable } from "./RegisterTable";
import { registerCopy } from "./copy";
import { PAGE_SIZE, type RegisterChain, complaintNumberOf, latestPageStart, pageWindow } from "./register-model";

const CHAINS: readonly RegisterChain[] = ["REG", "RRI"];

function SearchForm({ applied, onApply }: { readonly applied: string | undefined; readonly onApply: (number: string | undefined) => void }) {
  const copy = registerCopy.list;
  const [typed, setTyped] = useState(applied ?? "");
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const number = complaintNumberOf(typed);
    setInvalid(number === undefined);
    if (number !== undefined) onApply(number);
  };
  return (
    <form role="search" onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className={LABEL_CLASS}>
        {copy.searchLabel}
        <input
          className={`${FIELD_CLASS} min-w-56 font-mono`}
          value={typed}
          placeholder={copy.searchPlaceholder}
          aria-invalid={invalid ? true : undefined}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      <Button type="submit" variant="secondary">
        {copy.searchButton}
      </Button>
      {applied !== undefined ? (
        <Button
          variant="ghost"
          onClick={() => {
            setTyped("");
            setInvalid(false);
            onApply(undefined);
          }}
        >
          {copy.searchClear}
        </Button>
      ) : null}
      {invalid ? (
        <p role="alert" className="w-full text-xs text-danger">
          {copy.searchInvalid}
        </p>
      ) : null}
    </form>
  );
}

function Pager({ fromSeq, total, onMove }: { readonly fromSeq: number; readonly total: number; readonly onMove: (fromSeq: number) => void }) {
  const window = pageWindow(fromSeq, total);
  const { earlier, later } = window;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate">
      <span>{registerCopy.list.range(window.from, window.to, total)}</span>
      <span className="flex gap-2">
        <Button variant="secondary" disabled={earlier === undefined} onClick={() => earlier !== undefined && onMove(earlier)}>
          {registerCopy.list.earlier}
        </Button>
        <Button variant="secondary" disabled={later === undefined} onClick={() => later !== undefined && onMove(later)}>
          {registerCopy.list.later}
        </Button>
      </span>
    </div>
  );
}

export function RegisterView() {
  const { trpc } = useSession();
  const view = consoleCopy.views.register;
  const [chain, setChain] = useState<RegisterChain>("REG");
  const [fromSeq, setFromSeq] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState<string | undefined>(undefined);

  const verify = useRemote(`register.verify:${chain}`, (signal) => trpc.register.verify.query({ chain }, { signal }));
  const total = dataOf(verify.state)?.entries;
  const start = fromSeq ?? (total === undefined ? undefined : latestPageStart(total));
  const listInput = search !== undefined ? { chain: "REG" as const, complaintNumber: search } : start === undefined ? undefined : { chain, fromSeq: start, limit: PAGE_SIZE };
  const list = useRemoteInput("register.list", listInput, (input, signal) => trpc.register.list.query(input, { signal }));

  const pickChain = (next: RegisterChain) => {
    setChain(next);
    setFromSeq(undefined);
    setSearch(undefined);
  };

  return (
    <div className="space-y-6">
      <PageHeader title={view.title} description={view.description} />
      <FilterPills
        label={registerCopy.chains.label}
        variant="segmented"
        value={chain}
        onChange={pickChain}
        options={CHAINS.map((value) => ({ value, label: registerCopy.chains[value] }))}
      />
      <Section id="register-status" title={registerCopy.status.heading}>
        <RemoteBlock state={verify.state} onRetry={verify.reload}>
          {(verification) => <ChainStatus verification={verification} />}
        </RemoteBlock>
        <div className="mt-4 border-t border-mist pt-4">
          <ExportPanel key={chain} title={`${registerCopy.export.heading} · ${registerCopy.chains[chain]}`} run={() => trpc.register.export.query({ chain })} onExported={verify.reload} />
        </div>
      </Section>
      <Section id="register-entries" title={registerCopy.chains[chain]} actions={chain === "REG" ? <SearchForm key={chain} applied={search} onApply={setSearch} /> : undefined}>
        <div className="space-y-3">
          {search === undefined && total !== undefined && start !== undefined ? <Pager fromSeq={start} total={total} onMove={setFromSeq} /> : null}
          <RemoteBlock state={list.state} onRetry={list.reload}>
            {(page) =>
              search !== undefined && page.entries.length === 0 ? <Callout tone="neutral">{registerCopy.list.searchNone}</Callout> : <RegisterTable page={page} />
            }
          </RemoteBlock>
        </div>
      </Section>
    </div>
  );
}
