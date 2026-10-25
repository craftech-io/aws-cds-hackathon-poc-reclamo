// infra/workers.ts and infra/messaging-whatsapp.ts for a deployment that uses only the phone simulator (whatsappLiveApproval in infra/channel-modes.ts,
// docs/architecture-integrations.md §3.1): evaluated once in its own file, against the same recording
// stand-ins as workers-spec.test.ts (one evaluation per file keeps vitest's mocks applied).
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as spec from "./workers-spec";
import { fake, loadWorkers, type Loaded } from "./workers-spec.fakes";

vi.mock("./secrets", async () => (await import("./workers-spec.fakes")).secretsModule());
vi.mock("./storage", async () => (await import("./workers-spec.fakes")).storageModule());
vi.mock("./channel-modes", () => ({ ChannelModes: { link: "ChannelModes" } }));
vi.mock("./guardrail", async () => (await import("./workers-spec.fakes")).guardrailModule());
vi.mock("./messaging-email", async () => (await import("./workers-spec.fakes")).emailModule());

const WP20: readonly spec.Wp20Lambda[] = Object.keys(spec.HANDLERS) as spec.Wp20Lambda[];

let simulated: Loaded;
beforeAll(async () => {
  simulated = await loadWorkers({ WabaId: "not-connected", WhatsAppPhoneNumberId: "not-connected" });
});

describe("WhatsApp number not configured (WabaId is not-connected)", () => {
  it("has no End User Messaging Social statement at all while the number is not connected", async () => {
    for (const fn of WP20) {
      const { actions, extra } = await fake.generatedActions(simulated, fn);
      expect(actions.some((action) => action.startsWith("social-messaging:")), fn).toBe(false);
      expect(extra, fn).toEqual([]);
    }
  });

  it("lets nobody outside the account publish while the WABA is not connected", async () => {
    const policy = JSON.parse(await fake.topicPolicy(simulated)) as { Statement: Array<{ Action: string | string[]; Principal: object }> };
    expect(policy.Statement.flatMap((statement) => [statement.Action].flat())).not.toContain("sns:Publish");
    expect(JSON.stringify(policy)).not.toContain("social-messaging");
  });
});
