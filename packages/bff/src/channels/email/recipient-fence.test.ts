// The recipient fence of the SES client (FL-073): only SES's mailbox simulator (with its `+` labels)
// and, only from the `demo` world, a registered demo recipient; the strict parser and the reserved
// domains refuse everything else, look-alikes included.
import { describe, expect, it } from "vitest";
import { isReservedDomain, parseAddress } from "./address";
import { RECIPIENT_FENCE_RULE, checkRecipientFence, demoRecipientsFromSeedOverrides } from "./recipient-fence";

const DEMO = ["equipo-demo@craftech.io"];
const fence = (worldId: string, to: string, demo: readonly string[] = DEMO) => checkRecipientFence({ worldId, to }, () => demo);

describe("recipient fence [FL-073]", () => {
  it.each([
    ["success@simulator.amazonses.com", "success"],
    ["bounce+g01-cus-0039@simulator.amazonses.com", "bounce"],
    ["complaint+gs-abcdefghij-cus-0002@simulator.amazonses.com", "complaint"],
    ["ooto+qa-123456789-1-sc17-c01@simulator.amazonses.com", "ooto"],
    ["suppressionlist@simulator.amazonses.com", "suppressionlist"],
  ])("lets %s through to the simulator", (to, mailbox) => {
    expect(fence("g01", to)).toEqual({ allowed: true, to: { address: to, local: to.split("@")[0], domain: "simulator.amazonses.com" }, target: "SIMULATOR", mailbox });
  });

  it.each([
    ["success@simulator.amazonses.com.example.net", "RESERVED_DOMAIN"],
    ["success@simulator.amazonses.com.attacker.io", "NOT_ALLOWED"],
    ["success@sub.simulator.amazonses.com", "NOT_ALLOWED"],
    ["Success@simulator.amazonses.com", "ADDRESS_UPPER_CASE"],
    ["success@Simulator.AmazonSES.com", "ADDRESS_UPPER_CASE"],
    ['"success"@simulator.amazonses.com', "ADDRESS_SPECIAL_CHARACTERS"],
    ["success@simulator.amazonses.com@craftech.io", "ADDRESS_AT_COUNT"],
    ["success@simulator.amazonses.com\r\nBcc: x@craftech.io", "ADDRESS_CONTROL_CHARACTERS"],
    ["Ana <success@simulator.amazonses.com>", "ADDRESS_WHITESPACE"],
    ["success@xn--simulator-9ya.com", "ADDRESS_IDN"],
    ["success@simulator.amazonses.com.", "ADDRESS_TRAILING_DOT"],
    ["ñandu@simulator.amazonses.com", "ADDRESS_NON_ASCII"],
    ["admin@simulator.amazonses.com", "SIMULATOR_MAILBOX"],
    ["success+UPPER@simulator.amazonses.com", "ADDRESS_UPPER_CASE"],
    ["success+a_b@simulator.amazonses.com", "SIMULATOR_LABEL"],
    [`success+${"a".repeat(41)}@simulator.amazonses.com`, "SIMULATOR_LABEL"],
    ["cliente@jarilla.test", "RESERVED_DOMAIN"],
    ["cliente@example.com", "RESERVED_DOMAIN"],
    ["cliente@mail.example.org", "RESERVED_DOMAIN"],
    ["cliente@host.invalid", "RESERVED_DOMAIN"],
    ["cliente@localhost", "ADDRESS_DOMAIN"],
    ["cliente@empresa-ficticia.ar", "NOT_ALLOWED"],
    ["otra-persona@craftech.io", "NOT_ALLOWED"],
  ])("refuses %s (%s)", (to, reason) => {
    expect(fence("demo", to)).toEqual({ allowed: false, code: "RECIPIENT_NOT_ALLOWED", ruleId: RECIPIENT_FENCE_RULE, reason });
  });

  it("lets a registered demo recipient through only from the demo world", () => {
    expect(fence("demo", "equipo-demo@craftech.io")).toMatchObject({ allowed: true, target: "DEMO_RECIPIENT" });
    for (const worldId of ["g01", "gtest", "gprobe", "gs-abcdefghij", "qa-123456789-1-sc14", "qamin", "sim-batch-1"]) {
      expect(fence(worldId, "equipo-demo@craftech.io")).toMatchObject({ allowed: false, reason: "DEMO_RECIPIENT_OUTSIDE_DEMO" });
    }
  });

  it("never treats an unregistered @craftech.io address as a demo recipient", () => {
    expect(fence("demo", "equipo-demo@craftech.io", [])).toMatchObject({ allowed: false, reason: "NOT_ALLOWED" });
  });
});

describe("demo recipients from SeedOverrides [FL-073]", () => {
  it("reads at most five strict @craftech.io addresses", () => {
    expect(demoRecipientsFromSeedOverrides(JSON.stringify({ demoRecipients: { emails: ["a@craftech.io", "b@craftech.io"] }, budgetEmail: "x" }))).toEqual(["a@craftech.io", "b@craftech.io"]);
    expect(demoRecipientsFromSeedOverrides("{}")).toEqual([]);
    expect(demoRecipientsFromSeedOverrides(undefined)).toEqual([]);
  });

  it.each([
    ["not JSON", "{oops"],
    ["six addresses", JSON.stringify({ demoRecipients: { emails: Array.from({ length: 6 }, (_, n) => `p${n}@craftech.io`) } })],
    ["an address of another domain", JSON.stringify({ demoRecipients: { emails: ["a@craftech.io", "b@empresa-ficticia.ar"] } })],
    ["a look-alike domain", JSON.stringify({ demoRecipients: { emails: ["a@craftech.io.example.net"] } })],
    ["an upper-case address", JSON.stringify({ demoRecipients: { emails: ["A@craftech.io"] } })],
  ])("fails closed with %s", (_label, raw) => {
    expect(demoRecipientsFromSeedOverrides(raw)).toEqual([]);
  });
});

describe("strict address parser [FL-073]", () => {
  it("keeps the address exactly as given and splits it", () => {
    expect(parseAddress("bounce+g01-cus-0039@simulator.amazonses.com")).toEqual({ ok: true, value: { address: "bounce+g01-cus-0039@simulator.amazonses.com", local: "bounce+g01-cus-0039", domain: "simulator.amazonses.com" } });
  });

  it("refuses dots out of place and empty parts", () => {
    for (const raw of [".a@craftech.io", "a.@craftech.io", "a..b@craftech.io", "@craftech.io", "a@", "a@craftech", "a@-craftech.io"]) {
      expect(parseAddress(raw).ok).toBe(false);
    }
  });

  it("knows the reserved domains and their subdomains", () => {
    for (const domain of ["example.com", "a.example.net", "x.test", "y.invalid", "z.localhost", "home.arpa", "printer.local"]) expect(isReservedDomain(domain)).toBe(true);
    for (const domain of ["simulator.amazonses.com", "craftech.io", "examples.com"]) expect(isReservedDomain(domain)).toBe(false);
  });
});
