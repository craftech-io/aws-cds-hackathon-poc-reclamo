// "Responder por escrito" (docs/design-brief.md §8.7; FL-089): a person's written answer to a case
// that is with a person: the resolution, the text (the agent's suggested draft when there is one) and
// the attachments asked for; the code decides which attachments are eligible. `complaints.answer`
// ENQUEUES it: the worker renders the PDF and sends it by email through the gate. It needs a sign-in
// of at most 15 minutes: the password prompt opens in place and the answer goes on once confirmed.
import { useState } from "react";
import { type ComplaintOutcome, ComplaintOutcome as Outcomes } from "@reclamo/shared";
import { COMPLAINT_OUTCOME_GLOSS, COMPLAINT_OUTCOME_LABEL } from "@reclamo/bff/copy/index";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { useSession } from "../../context/SessionContext";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useRecentLoginAction } from "../approvals/use-recent-login-action";
import type { CaseBundle } from "./api";
import { CaseError } from "./CaseHeader";
import { complaintCopy } from "./copy";

const text = complaintCopy.answer;
const ATTACHMENTS = ["STATEMENT", "CREDIT_NOTE", "PAYOFF_CERTIFICATE"] as const;
type Attachment = (typeof ATTACHMENTS)[number];

interface AnswerDraft {
  readonly outcome: ComplaintOutcome;
  readonly draftBody: string;
  readonly requestedAttachments: Attachment[];
}

/** The latest note the agent left on the case: its suggested draft. */
export function suggestedDraft(bundle: CaseBundle): string | undefined {
  return [...bundle.view.notes].reverse().find((note) => note.kind === "NOTE" && note.author === "AGENT")?.text;
}

function Form({ bundle, onChange }: { readonly bundle: CaseBundle; readonly onChange: () => void }) {
  const { trpc } = useSession();
  const suggested = suggestedDraft(bundle);
  const [outcome, setOutcome] = useState<ComplaintOutcome>("IN_FAVOUR");
  const [draftBody, setDraftBody] = useState(suggested ?? "");
  const [attachments, setAttachments] = useState<ReadonlySet<Attachment>>(new Set());
  const answer = useRecentLoginAction<AnswerDraft, RouterOutputs["complaints"]["answer"]>(
    (draft) => trpc.complaints.answer.mutate({ complaintId: bundle.view.complaint.complaintId, ...draft }),
    () => onChange(),
  );
  const toggle = (attachment: Attachment, on: boolean) =>
    setAttachments((current) => {
      const next = new Set(current);
      if (on) next.add(attachment);
      else next.delete(attachment);
      return next;
    });

  if (answer.state.status === "done") return <Callout tone="success">{text.queued}</Callout>;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (draftBody.trim() !== "") void answer.run({ outcome, draftBody: draftBody.trim(), requestedAttachments: [...attachments] });
      }}
    >
      <SelectField<ComplaintOutcome>
        label={text.outcome}
        value={outcome}
        options={Outcomes.options.map((option) => ({ value: option, label: `${COMPLAINT_OUTCOME_LABEL[option]} · ${COMPLAINT_OUTCOME_GLOSS[option]}` }))}
        onChange={setOutcome}
      />
      <label className={LABEL_CLASS}>
        {suggested !== undefined ? `${text.draft} (${text.suggested})` : text.draft}
        <textarea className={FIELD_CLASS} rows={6} maxLength={5000} required value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
      </label>
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate">{text.attachments}</legend>
        {ATTACHMENTS.map((attachment) => (
          <label key={attachment} className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="size-4 accent-seal-deep" checked={attachments.has(attachment)} onChange={(event) => toggle(attachment, event.target.checked)} />
            {text.attachment[attachment]}
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={answer.state.status === "running" || draftBody.trim() === ""}>
        {text.open}
      </Button>
      {answer.state.status === "error" ? <CaseError error={answer.state.error} /> : null}
    </form>
  );
}

export function AnswerForm({ bundle, onChange }: { readonly bundle: CaseBundle; readonly onChange: () => void }) {
  const { status } = bundle.view.complaint;
  return (
    <Section id="answer" title={complaintCopy.sections.answer} description={text.lead}>
      {status === "HUMAN_REVIEW" ? <Form bundle={bundle} onChange={onChange} /> : <p className="text-sm text-slate">{text.onlyHumanReview}</p>}
    </Section>
  );
}
