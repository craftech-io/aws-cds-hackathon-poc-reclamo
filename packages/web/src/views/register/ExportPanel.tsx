// "Exportar con verificación" of the register and of the tape (FL-096): the BFF verifies the chain
// against its anchors, writes CSV, JSON and the `.sha256` sums to `Exports` and answers 5-minute
// links; the panel shows the result of that verification next to the files, so what is downloaded
// always carries the state it was exported in. The files are plain downloads (not images or PDFs),
// so they open from their link instead of a `blob:` URL.
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { useAction } from "../../lib/use-remote";
import { ChainStatus } from "./ChainStatus";
import { registerCopy } from "./copy";
import { type ChainExportResult, shortHash } from "./register-model";

const FILES = ["csv", "json", "sha256"] as const;

interface ExportPanelProps {
  readonly run: () => Promise<ChainExportResult>;
  /** Accessible name of the export block ("Exportación del registro de reclamos"). */
  readonly title: string;
  /** Called after an export: the chain status above may have changed. */
  readonly onExported?: (result: ChainExportResult) => void;
}

export function ExportPanel({ run, title, onExported }: ExportPanelProps) {
  const copy = registerCopy.export;
  const action = useAction<void, ChainExportResult>(() => run());
  const start = () =>
    void action.run().then((result) => {
      if (result !== undefined) onExported?.(result);
    });
  const done = action.state.status === "done" ? action.state.data : undefined;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={start} disabled={action.state.status === "running"}>
          {action.state.status === "running" ? copy.running : copy.button}
        </Button>
        <p className="max-w-2xl text-xs text-slate">{copy.lead}</p>
      </div>
      {action.state.status === "error" ? <ApiErrorNotice error={action.state.error} /> : null}
      {done ? (
        <div className="space-y-3 rounded-card border border-mist bg-paper p-4">
          <ChainStatus verification={done} title={copy.heading} />
          <ul className="flex flex-wrap gap-3">
            {FILES.map((ext) => {
              const file = done.files[ext];
              return (
                <li key={ext} className="flex flex-col gap-0.5">
                  <a href={file.url} download target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-seal-deep underline">
                    {copy[ext]}
                  </a>
                  <span className="text-xs text-slate">
                    {copy.sha}{" "}
                    <code className="font-mono" title={file.sha256}>
                      {shortHash(file.sha256)}
                    </code>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-slate">{copy.linkNote}</p>
        </div>
      ) : null}
    </section>
  );
}
