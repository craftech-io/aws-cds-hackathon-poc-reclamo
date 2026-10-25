import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODES_FILE, checkModes, readModes } from "./check-modes";

const TODAY = "2026-10-25";
const APPROVED = `{ date: "2026-10-20", approver: "CTO" }`;

const modesSource = (liveWorlds: string, approval = "null", email = "live") => `
export const whatsappLiveApproval: { readonly date: string; readonly approver: string } | null = ${approval};

export const channelModes = {
  email: "${email}",
  whatsapp: {
    liveWorlds: [${liveWorlds}] as string[], // set together with whatsappLiveApproval, in a reviewed PR
  },
};
`;

describe("readModes", () => {
  it("reads the email mode, the literal list of live worlds and the approval", () => {
    expect(readModes(modesSource(""))).toEqual({ email: "live", liveWorlds: [], approval: null });
    expect(readModes(modesSource(`"demo", "qa-live-*"`, APPROVED))).toEqual({
      email: "live",
      liveWorlds: ["demo", "qa-live-*"],
      approval: { date: "2026-10-20", approver: "CTO" },
    });
  });

  it("refuses a list item that is not a plain string literal", () => {
    expect(readModes(modesSource(`"demo", process.env.WORLD`)).liveWorlds).toBeUndefined();
    expect(readModes(`email: process.env.MODE ?? "live",`)).toEqual({ email: undefined, approval: undefined });
  });
});

describe("checkModes [FL-104]", () => {
  it("passes while no world runs WhatsApp live", () => {
    expect(checkModes(modesSource(""), TODAY)).toEqual([]);
  });

  it("fails when a world is live without an approval", () => {
    const errors = checkModes(modesSource(`"demo"`), TODAY);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("WhatsApp is live in demo");
    expect(errors[0]).toContain("whatsappLiveApproval is not set");
  });

  it("fails when the approval has a bad or future date or no approver", () => {
    for (const date of ["2026-10-26", "2026-13-01", "20/10/2026", ""]) {
      const errors = checkModes(modesSource(`"demo"`, `{ date: "${date}", approver: "CTO" }`), TODAY);
      expect(errors, date).toHaveLength(1);
      expect(errors[0]).toContain("whatsappLiveApproval.date");
    }
    const errors = checkModes(modesSource(`"demo"`, `{ date: "2026-10-20", approver: " " }`), TODAY);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("whatsappLiveApproval.approver is empty");
  });

  it("passes when demo and the QA live worlds are live with an approval", () => {
    expect(checkModes(modesSource(`"demo", "qa-live-*"`, APPROVED), TODAY)).toEqual([]);
    expect(checkModes(modesSource(`"demo"`, `{ date: "${TODAY}", approver: "CTO" }`), TODAY)).toEqual([]);
  });

  it("never lets a guest, gtest, QA or simulated-load world run live, even with an approval", () => {
    for (const world of ["g01", "gtest", "gprobe", "qa-run1-sc01", "qamin", "sim-001", "*"]) {
      const errors = checkModes(modesSource(`"${world}"`, APPROVED), TODAY);
      expect(errors, world).toHaveLength(1);
      expect(errors[0]).toContain(`world "${world}" can never run WhatsApp live`);
    }
  });

  it("fails when the list is missing or when email is not live", () => {
    expect(checkModes(`email: "live",\n`, TODAY)[0]).toContain("liveWorlds not found");
    expect(checkModes(modesSource("", "null", "simulated"), TODAY)[0]).toContain('email must be "live"');
  });
});

describe("repository state", () => {
  it("the committed modes pass the check", () => {
    const root = resolve(__dirname, "../..");
    const modes = readFileSync(resolve(root, MODES_FILE), "utf8");
    expect(checkModes(modes)).toEqual([]);
    expect(readModes(modes)).toEqual({ email: "live", liveWorlds: [], approval: null });
  });
});
