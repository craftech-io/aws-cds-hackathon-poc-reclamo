import { describe, expect, it } from "vitest";
import { actionText, outcomeText, timerKindText } from "../views/complaint/action-copy";
import { scanText } from "./media";

describe("the scan state of an image in words", () => {
  it("[FL-029] maps every state to Spanish and never shows a raw code", () => {
    expect(scanText("SEED_SKIPPED")).toBe("Escaneo: comprobante de muestra, ya verificado");
    expect(scanText("NO_THREATS_FOUND")).toBe("Escaneo: sin amenazas");
    expect(scanText("SOMETHING_NEW")).toBe("Escaneo: escaneo sin resultado conocido");
    expect(scanText(null)).toBe("Escaneo: escaneo en curso");
    for (const state of ["SEED_SKIPPED", "NO_THREATS_FOUND", "THREATS_FOUND", "SOMETHING_NEW"]) expect(scanText(state)).not.toContain(state);
  });
});

describe("audit actions of the case timeline in words", () => {
  it("[FL-017] labels tools, system actions, outcomes and timers; an unknown code is a generic entry", () => {
    expect(actionText("RECONCILE_PAYMENT")).toBe("Buscó el pago en la rendición");
    expect(actionText("EMAIL_EVENT")).toBe("Evento del email (SES)");
    expect(actionText("NOT_A_REAL_ACTION")).toBe("Registro del sistema");
    expect(outcomeText("RECONCILED_BY_CODE")).toBe("Conciliado por código");
    expect(outcomeText("NOT_A_REAL_OUTCOME")).toBeUndefined();
    expect(outcomeText(null)).toBeUndefined();
    expect(timerKindText("AUTO_CLOSE")).toBe("Cierre automático");
    expect(timerKindText("NEW_KIND")).toBe("Hito");
  });
});
