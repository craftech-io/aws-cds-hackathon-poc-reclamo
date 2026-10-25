// Labels the console shares between views: the kinds of the world clock's timers (the clock and the
// case timeline) and the fictitious collection networks (the clock and the case evidence).
export const TIMER_KIND_LABEL: Readonly<Record<string, string>> = {
  SLA: "Hito del plazo",
  SETTLEMENT_PUBLISH: "Publicación de rendición",
  SETTLEMENT_RECHECK: "Rechequeo contra la rendición",
  NETWORK_TRANSITION: "Cambio de estado en la red",
  DEFERRED_SEND: "Envío diferido",
  FOLLOW_UP: "Seguimiento",
  AUTO_CLOSE: "Cierre automático",
};

export const NETWORK_LABEL: Readonly<Record<string, string>> = { NORTE: "Red de cobro Norte", SUR: "Red de cobro Sur", WALLET: "Billetera de Jarilla" };
