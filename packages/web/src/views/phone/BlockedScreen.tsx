// The notice of a blocked account (docs/architecture-guests.md §18): an operator blocked it, so the BFF
// answers ACCOUNT_BLOCKED to every procedure, the SMS code included. Nothing here can lift it; the only
// ways out are Craftech's contact and signing out.
import { useSession } from "../../context/SessionContext";
import { EXTERNAL_LINK, contactHref } from "../landing/links";
import { AuthLayout } from "../login/AuthLayout";
import { useAuthLang } from "../login/auth-lang";
import { LinkButton, StepHeading } from "../login/form-parts";

const LINK = "font-semibold text-seal-deep underline underline-offset-2";

export function BlockedScreen() {
  const { copy } = useAuthLang();
  const { signOut } = useSession();
  const text = copy.phone;
  return (
    <AuthLayout>
      <div className="space-y-4">
        <StepHeading title={text.blocked.title} lead={text.blocked.lead} />
        <p className="text-sm">
          <a className={LINK} href={contactHref("account-blocked")} {...EXTERNAL_LINK}>
            {text.contact}
          </a>
        </p>
        <div className="border-t border-mist pt-4 text-center">
          <LinkButton onClick={signOut}>{text.signOut}</LinkButton>
        </div>
      </div>
    </AuthLayout>
  );
}
