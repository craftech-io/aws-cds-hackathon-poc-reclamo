// Step 5 of the tour: an operator's "Recordatorio de mora" on WhatsApp, blocked by CH-WA-NO-COLLECTION
// and rerouted to the formal notice by email, on the compliance tape. From 768 px the rows are the
// console's own `TapeRow`; below that the same entries become cards (docs/landing-spec.md §3.2, so no
// width scrolls sideways), and the console's mobile tape can take this card as is. On the English page
// every Spanish term carries its gloss ("BLOQUEADO · BLOCKED").
import { tapeBanner } from "@reclamo/bff/copy/block-reasons";
import { TAPE_DECISION_GLOSS } from "@reclamo/bff/copy/en-gloss";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { RuleChips } from "../../../components/RuleChips";
import { DECISION_LABEL, TapeRow, type TapeRowEntry } from "../../../components/TapeRow";
import { useLandingCopy } from "../lang";
import { REROUTE_TEXT, TAPE_ENTRIES, TAPE_KIND_LABEL, TAPE_TARGET } from "./demo-data";
import { Gloss, useInlineGloss, useShowGloss } from "./gloss";

const TONE: Readonly<Record<TapeRowEntry["decision"], BadgeTone>> = { ALLOWED: "success", BLOCKED: "danger", REROUTED: "warning", DEFERRED: "info", DISPATCH: "neutral" };

function decisionText(entry: TapeRowEntry) {
  return { es: DECISION_LABEL[entry.decision], en: TAPE_DECISION_GLOSS[entry.decision] };
}

function kindText(entry: TapeRowEntry) {
  return TAPE_KIND_LABEL[entry.kind] ?? { es: entry.kind, en: entry.kind };
}

/** One tape entry as a card: the same data as `TapeRow`, laid out vertically. */
export function TapeCard({ entry }: { readonly entry: TapeRowEntry }) {
  const label = useInlineGloss();
  const { visuals } = useLandingCopy();
  return (
    <li className={`rounded-md border border-mist p-3 ${entry.decision === "BLOCKED" ? "bg-danger-soft" : "bg-white"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone={TONE[entry.decision]}>{label(decisionText(entry))}</Badge>
        <span className="text-xs text-slate">{entry.atText}</span>
      </div>
      <p className="mt-2 text-sm text-ink">{label(kindText(entry))}</p>
      <p className="mt-1 text-xs text-slate">
        {visuals.sender}: {entry.sender} · {visuals.channel}: {entry.channel}
      </p>
      <div className="mt-2">
        <RuleChips ids={entry.ruleIds} />
      </div>
    </li>
  );
}

function GlossRow({ entry }: { readonly entry: TapeRowEntry }) {
  const label = useInlineGloss();
  return (
    <tr>
      <td colSpan={6} className="px-3 pb-2 text-xs italic text-slate">
        {label(decisionText(entry))} · {label(kindText(entry))}
      </td>
    </tr>
  );
}

export function TapeVisual() {
  const { visuals } = useLandingCopy();
  const showGloss = useShowGloss();
  const banner = tapeBanner("BLOCKED", "CH-WA-NO-COLLECTION");
  return (
    <div className="space-y-3">
      <p role="note" className="rounded-md border border-danger/30 bg-seal-mist px-3 py-2 text-xs font-semibold text-danger">
        {banner.es}
        <Gloss text={banner} className="font-normal" />
      </p>
      <p className="text-xs text-slate">
        {visuals.customer}: {TAPE_TARGET}
      </p>
      <ul className="space-y-2 md:hidden">
        {TAPE_ENTRIES.map((entry) => (
          <TapeCard key={`${entry.decision}-${entry.atText}`} entry={entry} />
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-md border border-mist md:block">
        <table className="w-full text-left">
          <thead className="bg-paper text-xs uppercase tracking-wide text-slate">
            <tr>
              {visuals.tapeHeads.map((head) => (
                <th key={head} scope="col" className="px-3 py-2 font-semibold">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-mist">
            {TAPE_ENTRIES.map((entry) => (
              <TapeRowWithGloss key={`${entry.decision}-${entry.atText}`} entry={entry} showGloss={showGloss} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-pine">
        → {REROUTE_TEXT.es}
        <Gloss text={REROUTE_TEXT} />
      </p>
    </div>
  );
}

function TapeRowWithGloss({ entry, showGloss }: { readonly entry: TapeRowEntry; readonly showGloss: boolean }) {
  return (
    <>
      <TapeRow entry={entry} />
      {showGloss ? <GlossRow entry={entry} /> : null}
    </>
  );
}
