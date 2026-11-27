// Doubles of the SMS code for tests, the local flows and the UI server: the memory SMS outbox (nothing
// reaches a phone), the service over any store with test keys, and a gate that lets every session in
// for the suites that test something else (the SMS code itself is tested with the real service).
import type { AuditSink } from "../auth/audit";
import type { RepoContext } from "../connector/codec";
import type { Connector } from "../connector/port";
import { signupCaps } from "../guests/caps";
import type { ProvisionInvoker } from "../guests/provision";
import { leadsRepo } from "../leads/repo";
import type { Logger } from "../lib/log";
import { secondFactorHashes } from "./hashes";
import { PassCache, type SecondFactorService, secondFactorService } from "./service";
import { type SmsMessage, type SmsSender, SmsUndeliverable } from "./sms";

export const TEST_PHONE_HASH_KEY = "test-phone-hash-key-of-32-characters-or-more";

export interface MemorySms extends SmsSender {
  readonly outbox: SmsMessage[];
  /** The next send fails as an undeliverable number. */
  failNext(): void;
  /** The code of the last SMS to `phone`. */
  lastCode(phone?: string): string | undefined;
}

export function memorySmsSender(): MemorySms {
  const outbox: SmsMessage[] = [];
  let fail = false;
  return {
    outbox,
    failNext: () => {
      fail = true;
    },
    lastCode: (phone) => {
      const last = [...outbox].reverse().find((message) => phone === undefined || message.phone === phone);
      return last ? /(\d{6})/.exec(last.text)?.[1] : undefined;
    },
    async send(message) {
      if (fail) {
        fail = false;
        throw new SmsUndeliverable("test");
      }
      outbox.push(message);
    },
  };
}

export interface TestSecondFactorInput {
  readonly ctx: RepoContext;
  readonly worlds: Pick<Connector["worlds"], "getMeta" | "getStaff">;
  readonly audit: AuditSink;
  readonly sms?: SmsSender;
  readonly invoker?: ProvisionInvoker;
  readonly newCode?: () => string;
}

/** The real service over a test store and test keys; one cache per call, like one container. */
export function testSecondFactor(input: TestSecondFactorInput): (log: Logger) => SecondFactorService {
  const cache = new PassCache();
  const invoker: ProvisionInvoker = input.invoker ?? { createWorld: async () => undefined, notifyLead: async () => undefined };
  return (log) =>
    secondFactorService({
      ctx: input.ctx,
      worlds: input.worlds,
      leads: leadsRepo(input.ctx),
      caps: signupCaps(input.ctx),
      hashes: secondFactorHashes(TEST_PHONE_HASH_KEY),
      sms: input.sms ?? memorySmsSender(),
      invoker,
      audit: input.audit,
      cache,
      log,
      ...(input.newCode ? { newCode: input.newCode } : {}),
    });
}

/** Every session passed: for the suites whose subject is not the SMS code. */
export function passedSecondFactor(): (log: Logger) => SecondFactorService {
  const passed = { state: "PASSED" } as const;
  const service: SecondFactorService = {
    check: async () => "PASSED",
    status: async () => passed,
    sendCode: async () => ({ status: "NOT_REQUIRED" }),
    verify: async () => ({ status: "VERIFIED" }),
    blocked: async () => false,
    endSession: async () => ({ status: "ENDED" }),
  };
  return () => service;
}
