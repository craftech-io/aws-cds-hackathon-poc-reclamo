// Human mode in the case (docs/design-brief.md §8.7; FL-084, FL-085, FL-069, FL-067): take the
// conversation from the agent, write in the same WhatsApp thread, hand it back. Everything a person
// writes is ENQUEUED and goes through the same gate as the agent (GateTrail shows the decision).
// Outside the 24-hour window the free text is disabled and only the approved templates go out, with
// the status phrase picked from the closed list.
import { useState } from "react";
import type { StatusPhraseId, TemplateName } from "@reclamo/bff/copy/index";
import { STATUS_PHRASE_IDS, TEMPLATE_STATUS_PHRASES, renderTemplateBody } from "@reclamo/bff/copy/index";
import { formatSimInstant } from "@reclamo/shared";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { useSession } from "../../context/SessionContext";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useAction } from "../../lib/use-remote";
import { GateTrail } from "../customer/GateTrail";
import type { CaseBundle } from "./api";
import { CaseError } from "./CaseHeader";
import { complaintCopy } from "./copy";

const text = complaintCopy.conversation;
type Sent = RouterOutputs["conversation"]["send"];
type Outgoing = { readonly text: string } | { readonly template: { readonly name: TemplateName; readonly params: string[] } };

/** The templates a person can fill from the case (the resolved one needs the masked email, which the console never holds). */
const CASE_TEMPLATES = ["reclamo_novedad", "reclamo_derivado", "reclamo_respuesta_no_entregada"] as const satisfies readonly TemplateName[];
type CaseTemplate = (typeof CASE_TEMPLATES)[number];

function paramsOf(name: CaseTemplate, bundle: CaseBundle, phrase: StatusPhraseId): string[] {
  const { complaint } = bundle.view;
  if (name === "reclamo_novedad") return [bundle.customer?.customer.firstName ?? "", complaint.complaintNumber, phrase];
  if (name === "reclamo_derivado") return [complaint.complaintNumber, complaint.deadlineText];
  return [complaint.complaintNumber];
}

/** Whether the customer wrote in the last 24 hours (simulated): only then may a person write free text. */
export function windowOpen(bundle: CaseBundle): boolean {
  const until = bundle.customer?.conversation?.windowOpenUntilSim;
  return until !== undefined && until !== null && Date.parse(until) > Date.parse(bundle.view.simNow);
}

function Writer({ bundle, onChange }: { readonly bundle: CaseBundle; readonly onChange: () => void }) {
  const { trpc } = useSession();
  const { complaint } = bundle.view;
  const open = windowOpen(bundle);
  const [message, setMessage] = useState("");
  const [template, setTemplate] = useState<CaseTemplate>("reclamo_novedad");
  const [phrase, setPhrase] = useState<StatusPhraseId>("HUMAN_REVIEWED");
  const [sent, setSent] = useState<Sent | undefined>(undefined);
  const send = useAction((outgoing: Outgoing) => trpc.conversation.send.mutate({ customerId: complaint.customerId, complaintId: complaint.complaintId, ...outgoing }));
  const params = paramsOf(template, bundle, phrase);
  const preview = params.every((param) => param !== "") ? renderTemplateBody(template, params) : undefined;

  const submit = async (outgoing: Outgoing) => {
    setSent(undefined);
    const queued = await send.run(outgoing);
    if (queued) {
      setSent(queued);
      setMessage("");
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate">{open && bundle.customer?.conversation?.windowOpenUntilSim ? text.windowOpen(formatSimInstant(bundle.customer.conversation.windowOpenUntilSim)) : text.windowClosed}</p>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (open && message.trim() !== "") void submit({ text: message.trim() });
        }}
      >
        <label className={LABEL_CLASS}>
          {text.text}
          <textarea className={FIELD_CLASS} rows={3} maxLength={900} disabled={!open} value={message} onChange={(event) => setMessage(event.target.value)} />
        </label>
        <Button type="submit" disabled={!open || send.state.status === "running" || message.trim() === ""}>
          {text.send}
        </Button>
      </form>
      {!open ? (
        <form
          className="space-y-2 rounded-card border border-mist bg-paper p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (preview !== undefined) void submit({ template: { name: template, params } });
          }}
        >
          <div className="flex flex-wrap gap-3">
            <SelectField<CaseTemplate> label={text.template} value={template} options={CASE_TEMPLATES.map((name) => ({ value: name, label: name }))} onChange={setTemplate} />
            {template === "reclamo_novedad" ? (
              <SelectField<StatusPhraseId> label={text.statusPhrase} value={phrase} options={STATUS_PHRASE_IDS.map((id) => ({ value: id, label: TEMPLATE_STATUS_PHRASES[id] }))} onChange={setPhrase} />
            ) : null}
          </div>
          {preview ? <p className="rounded-md bg-white px-3 py-2 text-sm text-ink">{preview}</p> : <p className="text-xs text-slate">{text.noCustomerFile}</p>}
          <Button type="submit" disabled={preview === undefined || send.state.status === "running"}>
            {text.send}
          </Button>
        </form>
      ) : null}
      {send.state.status === "error" ? <CaseError error={send.state.error} /> : null}
      {sent ? <GateTrail key={sent.messageId} messageId={sent.messageId} customerId={complaint.customerId} onChange={onChange} /> : null}
    </div>
  );
}

interface ConversationPanelProps {
  readonly bundle: CaseBundle;
  readonly staffId: string | undefined;
  readonly onChange: () => void;
}

export function ConversationPanel({ bundle, staffId, onChange }: ConversationPanelProps) {
  const { trpc } = useSession();
  const { complaint, conversation } = bundle.view;
  const control = useAction(async (to: "take" | "release") => {
    const ref = { customerId: complaint.customerId };
    const answer = to === "take" ? await trpc.conversation.take.mutate(ref) : await trpc.conversation.release.mutate(ref);
    onChange();
    return answer;
  });
  const byOperator = conversation?.control === "OPERATOR";
  const mine = byOperator && conversation?.controlledBy === staffId;
  const running = control.state.status === "running";

  return (
    <Section id="conversation" title={complaintCopy.sections.conversation} description={mine ? text.releaseHint : text.takeHint}>
      <div className="space-y-3">
        <p className="text-sm font-medium text-ink">{mine ? text.byMe : byOperator ? text.byOther : text.byAgent}</p>
        <div className="flex flex-wrap gap-2">
          {!byOperator ? (
            <Button disabled={running || conversation === null} onClick={() => void control.run("take")}>
              {text.take}
            </Button>
          ) : null}
          {mine ? (
            <Button variant="secondary" disabled={running} onClick={() => void control.run("release")}>
              {text.release}
            </Button>
          ) : null}
        </div>
        {control.state.status === "done" && "eventId" in control.state.data ? <Callout tone="success">{text.released}</Callout> : null}
        {control.state.status === "error" ? <CaseError error={control.state.error} /> : null}
        {mine ? <Writer bundle={bundle} onChange={onChange} /> : null}
      </div>
    </Section>
  );
}
