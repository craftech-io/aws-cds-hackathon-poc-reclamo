// docs/seed-spec.md §14: the committed seed passes the 22 invariants, and each invariant fails, with
// its number, when the seed is broken the way it guards against. Mutations work on a copy of the seed
// read once from disk, so the committed files are never touched.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { START_AT_SIM } from "../lib/constants";
import type { TemplateItem, WorldTemplateFile } from "../lib/template";
import { type Json, type SeedOnDisk, readSeed } from "../validate/read";
import { validateLoaded } from "../validate/run";

// Each case validates three whole world templates: seconds apiece when the full suite shares the machine.
vi.setConfig({ testTimeout: 60_000 });

let seed: SeedOnDisk;

beforeAll(() => {
  seed = readSeed();
});

type Mutable = { templates: Record<"demo" | "guest" | "qa-min", WorldTemplateFile>; manifest: Json; reference: Json; evals: SeedOnDisk["evals"]; files: Map<string, Buffer> };

/** A copy of the seed whose templates, manifest, reference and evals can be changed freely. */
function copy(): Mutable & SeedOnDisk {
  return { ...seed, templates: structuredClone(seed.templates), manifest: structuredClone(seed.manifest), reference: structuredClone(seed.reference), evals: structuredClone(seed.evals), files: new Map(seed.files) } as Mutable & SeedOnDisk;
}

function find(template: WorldTemplateFile, entity: string, where: (data: Json) => boolean): TemplateItem {
  const found = template.items.find((item) => item.entity === entity && where(item.data as Json));
  if (!found) throw new Error(`no ${entity} matches`);
  return found;
}

async function failures(mutate: (draft: Mutable & SeedOnDisk) => void): Promise<string[]> {
  const draft = copy();
  mutate(draft);
  return (await validateLoaded(draft, { forbiddenTerms: false })).errors;
}

function expectInvariant(errors: readonly string[], invariant: number): void {
  expect(errors.some((error) => error.startsWith(`invariant ${invariant}:`)), errors.slice(0, 5).join("\n")).toBe(true);
}

describe("the committed seed", () => {
  it("holds every invariant", async () => {
    const result = await validateLoaded(seed, { forbiddenTerms: false });
    expect(result.errors).toEqual([]);
  }, 120_000);
});

describe("each invariant catches what it guards", () => {
  it("1: a file that is not the one fingerprinted", async () => {
    expectInvariant(await failures((draft) => draft.files.set("data/load/batch-inputs.jsonl", Buffer.from("{}\n"))), 1);
  });

  it("2: an instalment whose parts do not add up", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.demo, "Instalment", (row) => row.loanId === "L-0001" && row.number === 1).data as Json).principal = 1)), 2);
  });

  it("3: an applied payment without its OPC# claim", async () => {
    expectInvariant(await failures((draft) => (draft.templates.demo.items = draft.templates.demo.items.filter((item) => !(item.entity === "ActionClaim" && item.pk.includes("#OPC#SUR#"))))), 3);
  });

  it("4: a pending line of another business date", async () => {
    expectInvariant(
      await failures((draft) => {
        const stored = find(draft.templates.guest, "SettlementLine", (data) => (data.line as Json).customerRef === "cus-0001").data as Json;
        (stored.line as Json).paidAt = "2026-10-05T10:00:00-03:00";
      }),
      4,
    );
  });

  it("5: a fake-unknown receipt whose code is in a settlement", async () => {
    expectInvariant(
      await failures((draft) => {
        const c18 = ((draft.evals.receipts.personas as Json[]).find((entry) => entry.persona === "C18")?.expected as Json).fields as Json;
        c18.operationCode = String((find(draft.templates.guest, "SettlementLine", () => true).data.line as Json).operationCode);
      }),
      5,
    );
  });

  it("6: an assignable phone", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.demo, "Customer", (data) => data.customerId === "cus-0002").data as Json).phoneE164 = "+5491155551234")), 6);
  });

  it("7: a CVU outside the synthetic prefix", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.demo, "Wallet", (data) => data.customerId === "cus-0002").data as Json).syntheticCvu = "0000003100000000000001")), 7);
  });

  it("8: a seeded verdict that check_charge does not give", async () => {
    expectInvariant(
      await failures((draft) => {
        const charge = find(draft.templates.demo, "Charge", (data) => data.customerId === "cus-0002" && data.feeCode === "FEE-CARD-REPL").data as Json;
        ((draft.manifest.facts as Json).chargeVerdicts as Record<string, Record<string, string>>).full = { ...((draft.manifest.facts as Json).chargeVerdicts as Record<string, Record<string, string>>).full, [String(charge.chargeId)]: "CORRECT" };
      }),
      8,
    );
  });

  it("9: a duplicate debit the core does not detect", async () => {
    expectInvariant(
      await failures((draft) => {
        const movement = find(draft.templates.demo, "Movement", (data) => data.customerId === "cus-0003" && data.kind === "DEBIT" && (data.ref as Json).paymentId === undefined).data as Json;
        movement.atSim = "2026-09-20T07:00:00-03:00";
      }),
      9,
    );
  });

  it("10: an outbound message without its ALLOWED entry", async () => {
    expectInvariant(await failures((draft) => (draft.templates.demo.items = draft.templates.demo.items.filter((item) => !(item.entity === "TapeEntry" && (item.data as Json).decision === "ALLOWED" && String((item.data as Json).tapeId).startsWith("tp-0003"))))), 10);
  });

  it("11: a WhatsApp outbound that reads as collection", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.demo, "Message", (data) => data.direction === "OUT").data as Json).body = "Te recordamos que tu cuota está vencida, pagala hoy para evitar recargos")), 11);
  });

  it("12: a register entry whose hash was rewritten", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.demo, "RegisterEntry", (data) => data.seq === 40).data as Json).status = "CLOSED")), 12);
  });

  it("13: a deadline that business-days.ts does not compute", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.demo, "Complaint", (data) => data.complaintNumber === "R-2026-000010").data as Json).deadlineSim = "2026-12-31T23:59:59-03:00")), 13);
  });

  it("14: an amount the flows quote that the manifest does not have", async () => {
    expectInvariant(await failures((draft) => (((draft.manifest.facts as Json).quoted as Record<string, Json>).C01 = { principal: "$ 960.000,00", instalment: "$ 1,00" })), 14);
  });

  it("[FL-017] 15: a timer between the start and the main story's publication", async () => {
    expectInvariant(
      await failures((draft) => {
        const timer = structuredClone(find(draft.templates.guest, "Timer", (data) => data.kind === "SETTLEMENT_PUBLISH"));
        Object.assign(timer.data, { timerId: "EXTRA", dueAtSim: "2026-10-07T12:00:00-03:00" });
        draft.templates.guest.items.push(timer);
      }),
      15,
    );
  });

  it("16: a contest word on a visible text of the seed", async () => {
    expectInvariant(await failures((draft) => draft.files.set("data/reference.json", Buffer.from('{"lender":"jurado"}\n'))), 16);
  });

  it("17: a seeded complaint that would count as measured", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates["qa-min"], "Complaint", () => true).data as Json).origin = "LIVE")), 17);
  });

  it("18: a world that is not pristine for the tour", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.guest, "StoredClock", () => true).data as Json).pausedSimNow = "2026-10-08T09:00:00-03:00")), 18);
  });

  it("19: an open complaint that would become overdue during the tour", async () => {
    expectInvariant(await failures((draft) => ((find(draft.templates.guest, "Complaint", (data) => data.status === "HUMAN_REVIEW").data as Json).deadlineSim = "2026-10-20T23:59:59-03:00")), 19);
  });

  it("[FL-064] [FL-065] 20: step 2b outside the formal debt notice hours", async () => {
    expectInvariant(await failures((draft) => (((draft.templates.guest.settings as Json).contactHours as Json).formalNotice = { from: "11:00", to: "18:00" })), 20);
  });

  it("[FL-017] 21: C01's pending line that would not match in one advance", async () => {
    expectInvariant(await failures((draft) => (((find(draft.templates.guest, "SettlementLine", (data) => (data.line as Json).customerRef === "cus-0001").data as Json).line as Json).amount = 100)), 21);
  });

  it("[FL-076] [FL-077] [FL-078] 22: C07's dates when the 12/10 holiday is missing", async () => {
    expectInvariant(
      await failures((draft) => {
        const holidays = draft.reference.holidays as Json;
        holidays.entries = (holidays.entries as Json[]).filter((holiday) => holiday.date !== "2026-10-12");
      }),
      22,
    );
  });

  it("starts every template at the same paused instant", () => {
    for (const template of Object.values(seed.templates)) expect(template.startAtSim).toBe(START_AT_SIM);
  });
});
