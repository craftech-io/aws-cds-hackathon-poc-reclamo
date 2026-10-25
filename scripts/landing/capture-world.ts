// The world the landing's captures show (docs/landing-spec.md §7, WP-44): one guest world of the `guest`
// template, deterministic (seed with a fixed seed, real time fixed, the scripted agent of the guided
// tour's replay), walked through the guided tour exactly as scripts/tour/timeline.ts replays it — every
// `run` move through the real `tour.run`, every guest task through its console procedure. The walk stops
// at the "moments" a capture asks for:
//
//   "<step>"          once the step's moves are done and its promised state holds (the replay's check)
//   "<step>:<view>"   when the step opens `view`, before the guest's task there (the approval still
//                     pending in Aprobaciones, the composer before the collection attempt)
//
// Only receipts of the seed ever reach the world (the tour's scripts attach them); nothing is uploaded.
import type { TourStepId, TourTarget } from "../../packages/web/src/views/tour/steps";
import type { TourPersona } from "../../packages/web/src/views/tour/steps";
import { type LfTourWorld, REPLAY_WORLD, createLfTourWorld, customerOf } from "../tour/lf-world";
import { GUEST_TASKS, REPLAYED_STEPS, STEP_CHECKS, type TourLanding } from "../tour/timeline";

export type MomentView = TourTarget["view"];
export type Moment = TourStepId | `${TourStepId}:${MomentView}`;

const MOMENT = /^(1|2|2b|3|4|5|6|7|8|9|10|12)(?::(simulator|emails|metrics|approvals|register|clock|customer|complaint))?$/;

export function isMoment(value: string): value is Moment {
  return MOMENT.test(value);
}

/** Every moment of the walk, in the order the walk reaches them. */
export function momentOrder(): Moment[] {
  return REPLAYED_STEPS.flatMap((step) => [...step.moves.flatMap((move) => (move.kind === "open" ? [`${step.id}:${move.target.view}` as Moment] : [])), step.id]);
}

export interface WalkReport {
  /** Promises of the tour the world did not keep, by step (as the replay reports them). */
  readonly problems: readonly string[];
  /** Moments that were reached but not shot because their own step broke a promise. */
  readonly blocked: readonly Moment[];
}

export interface CaptureWorld {
  readonly tour: LfTourWorld;
  readonly worldId: string;
  /** The id token of the world's guest (`guest-NN`), as the console keeps it after a sign-in. */
  guestToken(): string;
  /** The id of the complaint the guest filed for `persona` (the latest one), as the console links it. */
  complaintId(persona: TourPersona): Promise<string>;
  /** Walks the tour, calling `shoot` at each wanted moment, in order; stops after the last one. */
  walk(wanted: ReadonlySet<Moment>, shoot: (moment: Moment) => Promise<void>): Promise<WalkReport>;
}

export async function createCaptureWorld(): Promise<CaptureWorld> {
  const tour = await createLfTourWorld();
  const flow = tour.flow;
  const staff = flow.staff("GUEST", REPLAY_WORLD);
  return {
    tour,
    worldId: REPLAY_WORLD,
    guestToken: () => flow.localConsole.token({ worldId: REPLAY_WORLD, staff }),
    async complaintId(persona) {
      const live = (await flow.connector.complaints.listByCustomer(REPLAY_WORLD, customerOf(persona))).filter((complaint) => complaint.origin === "LIVE");
      const latest = live.sort((a, b) => a.complaintNumber.localeCompare(b.complaintNumber)).at(-1);
      if (latest === undefined) throw new Error(`${persona} has no complaint in the world yet`);
      return latest.complaintId;
    },
    async walk(wanted, shoot) {
      const order = momentOrder();
      const last = Math.max(...[...wanted].map((moment) => order.indexOf(moment)));
      const problems: string[] = [];
      const blocked: Moment[] = [];
      const at = async (moment: Moment, broken: boolean): Promise<boolean> => {
        if (wanted.has(moment)) {
          if (broken) blocked.push(moment);
          else await shoot(moment);
        }
        return order.indexOf(moment) >= last;
      };
      for (const step of REPLAYED_STEPS) {
        const landings: TourLanding[] = [];
        const failures: string[] = [];
        for (const move of step.moves) {
          try {
            if (move.kind === "run") {
              const landing = await tour.run(move.action);
              if (landing !== undefined) landings.push(landing);
              continue;
            }
            const moment: Moment = `${step.id}:${move.target.view}`;
            if (await at(moment, failures.length > 0)) return { problems: [...problems, ...failures], blocked };
            for (const task of GUEST_TASKS[moment] ?? []) await tour.task(task);
          } catch (error) {
            failures.push(`${step.id}: “${move.label.en}” failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const check = STEP_CHECKS[step.id];
        const broken = [...failures, ...(check === undefined ? [] : await check(tour, { landings, tape: await tour.newTape() }))];
        problems.push(...broken);
        if (await at(step.id, broken.length > 0)) break;
      }
      return { problems, blocked };
    },
  };
}
