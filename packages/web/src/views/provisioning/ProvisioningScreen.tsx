// The fixed screen of a self-signup world that is not `READY` (docs/landing-spec.md §9.4): preparing,
// in line with its position, being built, taking longer than expected, or expired with "Set up my
// environment". Nothing to do but wait (or sign out); the wait shows what the guest will try, from
// the landing's own tour, instead of a bare spinner. Never a raw Cognito error, never an email promise.
import { LANDING_COPY } from "../landing/copy";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang } from "../login/auth-lang";
import { ErrorNote, LinkButton, StepHeading } from "../login/form-parts";
import type { Phase } from "./provisioning-model";

export interface ProvisioningScreenProps {
  readonly phase: Exclude<Phase, { readonly kind: "ready" }>;
  readonly slow: boolean;
  readonly requesting: boolean;
  readonly rateLimited: boolean;
  onRequestWorld(): void;
  onSignOut(): void;
}

function Meanwhile() {
  const { lang, copy } = useAuthLang();
  const steps = Object.values(LANDING_COPY[lang].tour.steps);
  return (
    <section aria-labelledby="provisioning-meanwhile" className="mt-6 rounded-card border border-mist bg-white/60 p-5">
      <h2 id="provisioning-meanwhile" className="text-sm font-semibold text-pine">
        {copy.provisioning.meanwhile}
      </h2>
      <ol className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3 text-sm">
            <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-pine-mist text-xs font-semibold text-pine">
              {index + 1}
            </span>
            <span>
              <span className="font-semibold text-ink">{step.title}.</span> <span className="text-slate">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Waiting({ phase, slow }: { readonly phase: ProvisioningScreenProps["phase"]; readonly slow: boolean }) {
  const { copy } = useAuthLang();
  const text = copy.provisioning;
  let lead;
  if (phase.kind === "queued") {
    lead = (
      <>
        {text.queued.before}
        <strong className="text-ink">{phase.position}</strong>
        {text.queued.after}
      </>
    );
  } else lead = phase.kind === "creating" ? text.creating : text.preparingLead;
  return (
    <div className="space-y-4">
      <StepHeading title={text.preparingTitle} />
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1 h-3 w-3 shrink-0 animate-pulse rounded-full bg-seal motion-reduce:animate-none" />
        <p role="status" aria-live="polite" className="text-sm text-slate">
          {lead}
        </p>
      </div>
      {slow ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-ink">
          {text.slow}
        </p>
      ) : null}
    </div>
  );
}

export function ProvisioningScreen({ phase, slow, requesting, rateLimited, onRequestWorld, onSignOut }: ProvisioningScreenProps) {
  const { copy } = useAuthLang();
  const text = copy.provisioning;
  return (
    <AuthLayout below={<Meanwhile />}>
      {phase.kind === "expired" ? (
        <div className="space-y-4">
          <StepHeading title={text.expiredTitle} lead={text.expiredLead} />
          {rateLimited ? <ErrorNote>{copy.common.rateLimited}</ErrorNote> : null}
          <button
            type="button"
            onClick={onRequestWorld}
            disabled={requesting}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-seal px-4 text-sm font-semibold text-white transition-colors hover:bg-seal-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {requesting ? copy.common.working : text.expiredButton}
          </button>
        </div>
      ) : (
        <Waiting phase={phase} slow={slow} />
      )}
      <div className="mt-6 border-t border-mist pt-4 text-center">
        <LinkButton onClick={onSignOut}>{text.signOut}</LinkButton>
      </div>
    </AuthLayout>
  );
}
