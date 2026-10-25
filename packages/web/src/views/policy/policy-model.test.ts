import { describe, expect, it } from "vitest";
import { canCutAgent, capLines, killStateOf, parameterRows, type WorldParameters } from "./policy-model";

const parameters: WorldParameters = {
  contactHours: { weekday: { from: "08:00", to: "20:00" }, saturday: { from: "09:00", to: "13:00" }, formalNotice: { from: "09:00", to: "18:00" } },
  maxProactivePerDay: 3,
  rateLimitPerHour: 20,
  turnCaps: { perHour: 200, perDay: 1000 },
  imageReadsPerDay: 60,
  caps: {
    perAction: {
      APPLY_PAYMENT: { agentCents: 5_000_000, operatorCents: 20_000_000 },
      REVERSE_CHARGE: { agentCents: 1_000_000, operatorCents: 5_000_000 },
      REFUND_DUPLICATE: { agentCents: 1_000_000, operatorCents: 5_000_000 },
      TRANSFER_REVERSAL: { agentCents: 0, operatorCents: 5_000_000 },
    },
    autoActionsPer30Days: 2,
  },
  channelModes: { whatsapp: "simulated" },
};

describe("agent cut-off", () => {
  it("is offered only to a SUPERVISOR of the demo world (the BFF enforces the same row)", () => {
    expect(canCutAgent({ role: "SUPERVISOR", worldId: "demo" })).toBe(true);
    expect(canCutAgent({ role: "OPERATOR", worldId: "demo" })).toBe(false);
    expect(canCutAgent({ role: "COMPLIANCE", worldId: "demo" })).toBe(false);
    expect(canCutAgent({ role: "GUEST", worldId: "g03" })).toBe(false);
    expect(canCutAgent({ role: "SUPERVISOR", worldId: "qa-run-1" })).toBe(false);
    expect(canCutAgent({ role: "SUPERVISOR" })).toBe(false);
  });

  it("reads cut when the global or the world's cut is on", () => {
    expect(killStateOf({ agentKill: { global: false, world: false, since: null } })).toEqual({ cut: false, text: "El agente está activo · Agent running" });
    expect(killStateOf({ agentKill: { global: true, world: false, since: "2026-10-09T19:30:00.000Z" } })).toEqual({ cut: true, text: "Agente cortado desde vie 09/10 16:30 · Agent cut off" });
    expect(killStateOf({ agentKill: { global: false, world: true, since: null } }).cut).toBe(true);
  });
});

describe("world parameters", () => {
  it("lists contact hours and the daily maximum as assumptions, the caps in pesos", () => {
    const rows = parameterRows(parameters);
    expect(rows[0]).toEqual({ label: "Contacto proactivo, lunes a viernes", value: "08:00 a 20:00", assumption: true });
    expect(rows.find((row) => row.label.startsWith("Contactos proactivos"))).toMatchObject({ value: "3", assumption: true });
    expect(rows.find((row) => row.label.startsWith("Mensajes por hora"))?.assumption).toBeUndefined();
    expect(parameterRows({ ...parameters, contactHours: { ...parameters.contactHours, saturday: null } })[1]?.value).toBe("Sin contacto los sábados");
    expect(capLines(parameters)[0]).toEqual({ action: "Imputar un pago", text: "el agente hasta $ 50.000,00 · un operador hasta $ 200.000,00 · por encima, un supervisor" });
    expect(capLines(parameters)).toHaveLength(4);
  });
});
