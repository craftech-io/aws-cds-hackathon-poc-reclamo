import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAccessHandoff, heldPassword, holdLoginEmail, holdPassword, loginEmailHint, markSignupConfirmed, readPendingSignup, savePendingSignup } from "./handoff";

const EMAIL = "success+qa-run1-su1@simulator.amazonses.com";
const SIGNUP_ID = "abcdefghijklmnopqrstuvwxyz";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

let session: Storage;

beforeEach(() => {
  session = memoryStorage();
  vi.stubGlobal("window", { sessionStorage: session });
  forgetAccessHandoff();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the access screens hand each other [FL-113]", () => {
  it("keeps the signupId and the email in sessionStorage, never the password", () => {
    savePendingSignup({ signupId: SIGNUP_ID, email: EMAIL, resendAvailableAt: 30_000 });
    holdPassword("UnaClaveLarga2026");
    expect(readPendingSignup()).toEqual({ signupId: SIGNUP_ID, email: EMAIL, resendAvailableAt: 30_000 });
    expect(heldPassword()).toBe("UnaClaveLarga2026");
    const stored = [...Array(session.length).keys()].map((index) => session.getItem(session.key(index) ?? "") ?? "").join("\n");
    expect(stored).not.toContain("UnaClaveLarga2026");
  });

  it("spends the signupId on confirmation and pre-fills the login with the confirmed email", () => {
    savePendingSignup({ signupId: SIGNUP_ID, email: EMAIL, resendAvailableAt: 30_000 });
    expect(loginEmailHint()).toBeUndefined();
    markSignupConfirmed(EMAIL);
    expect(readPendingSignup()).toEqual({ email: EMAIL, resendAvailableAt: 0, confirmed: true });
    expect(loginEmailHint()).toBe(EMAIL);
    forgetAccessHandoff();
    expect(readPendingSignup()).toBeUndefined();
    expect(loginEmailHint()).toBeUndefined();
  });

  it("pre-fills the login after a reset, and ignores a tampered record", () => {
    holdLoginEmail(EMAIL);
    expect(loginEmailHint()).toBe(EMAIL);
    session.setItem("reclamo.signup.pending", JSON.stringify({ signupId: "../../x", email: EMAIL, resendAvailableAt: 0 }));
    expect(readPendingSignup()).toBeUndefined();
  });

  it("works without storage (a private window)", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    savePendingSignup({ signupId: SIGNUP_ID, email: EMAIL, resendAvailableAt: 0 });
    expect(readPendingSignup()).toBeUndefined();
  });
});
