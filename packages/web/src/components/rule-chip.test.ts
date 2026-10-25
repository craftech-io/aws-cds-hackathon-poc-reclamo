import { describe, expect, it } from "vitest";
import { ruleTone } from "./RuleChip";

describe("rule chips", () => {
  it("colours the rule families, with the collection block in red", () => {
    expect(ruleTone("CH-WA-NO-COLLECTION")).toBe("danger");
    expect(ruleTone("CH-WA-24H-WINDOW")).toBe("info");
    expect(ruleTone("CED-KILL-SWITCH")).toBe("brand");
    expect(ruleTone("LAM-SCOPE")).toBe("warning");
    expect(ruleTone("ALLOWED")).toBe("neutral");
  });
});
