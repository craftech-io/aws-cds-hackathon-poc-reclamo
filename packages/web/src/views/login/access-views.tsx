// The access screens by path (docs/landing-spec.md §9.1): what app.tsx renders without the console's
// session guard. The login is part of the main bundle; the sign-up, the code, the provisioning wait
// and the recovery load on demand, each inside the language of the access screens.
import { type ComponentType, Suspense, lazy } from "react";
import { FullScreenMessage } from "../../components/FullScreenMessage";
import { LOGIN_PATH, PROVISIONING_PATH, RECOVER_PATH, RECOVER_RESET_PATH, SIGNUP_PATH, SIGNUP_VERIFY_PATH } from "../../routes";
import { AuthLangProvider, useAuthLang } from "./auth-lang";
import { LoginView } from "./LoginView";

const SignupView = lazy(() => import("../signup/SignupView").then((module) => ({ default: module.SignupView })));
const VerifyView = lazy(() => import("../signup/VerifyView").then((module) => ({ default: module.VerifyView })));
const ProvisioningRoute = lazy(() => import("../provisioning/ProvisioningRoute").then((module) => ({ default: module.ProvisioningRoute })));
const RecoverView = lazy(() => import("../recover/RecoverView").then((module) => ({ default: module.RecoverView })));
const ResetView = lazy(() => import("../recover/ResetView").then((module) => ({ default: module.ResetView })));

function Loading() {
  return <FullScreenMessage title={useAuthLang().copy.common.loading} />;
}

function onDemand(View: ComponentType): ComponentType {
  return function AccessScreen() {
    return (
      <AuthLangProvider>
        <Suspense fallback={<Loading />}>
          <View />
        </Suspense>
      </AuthLangProvider>
    );
  };
}

const ACCESS_VIEWS: Readonly<Record<string, ComponentType>> = {
  [LOGIN_PATH]: LoginView,
  [SIGNUP_PATH]: onDemand(SignupView),
  [SIGNUP_VERIFY_PATH]: onDemand(VerifyView),
  [PROVISIONING_PATH]: onDemand(ProvisioningRoute),
  [RECOVER_PATH]: onDemand(RecoverView),
  [RECOVER_RESET_PATH]: onDemand(ResetView),
};

/** The access screen of `path`, or `undefined` for the console's paths. */
export function accessViewOf(path: string): ComponentType | undefined {
  return Object.hasOwn(ACCESS_VIEWS, path) ? ACCESS_VIEWS[path] : undefined;
}
