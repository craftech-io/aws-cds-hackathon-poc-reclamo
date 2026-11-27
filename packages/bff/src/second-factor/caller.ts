// The caller of the SMS code (second-factor/service.ts), from the verified principal and its world's
// `META`: nothing of it comes from the input.
import { isEmailUsername } from "../auth/guest-identity";
import type { Principal } from "../auth/principal";
import type { WorldMeta } from "../auth/staff";
import { GUEST_WORLD_PATTERN } from "../leads/keys";
import type { SecondFactorCaller } from "./service";

export function secondFactorCaller(principal: Principal, world: Pick<WorldMeta, "epoch">): SecondFactorCaller {
  return {
    sub: principal.sub,
    worldId: principal.worldId,
    staffId: principal.staffId,
    signInKey: principal.signInKey,
    authTime: principal.authTime,
    automation: principal.automation,
    selfSignup: isEmailUsername(principal.username) && GUEST_WORLD_PATTERN.test(principal.worldId),
    epoch: world.epoch,
  };
}
