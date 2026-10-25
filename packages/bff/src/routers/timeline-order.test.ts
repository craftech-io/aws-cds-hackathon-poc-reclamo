import { describe, expect, it } from "vitest";
import { type TimelineEntry, orderTimeline, pairStatusChanges } from "./timeline-order";

const AT = "2026-10-07T10:10:00-03:00";

describe("[FL-017] the order of a complaint's timeline with the clock paused", () => {
  it("[FL-017] three items of one simulated instant in reversed storage order come out in arrival order", () => {
    const items = orderTimeline([
      { type: "MESSAGE", direction: "OUT", atSim: AT, real: "2026-10-09T12:00:03.000Z", messageId: "m-ack", id: "m-ack", item: "ack" },
      { type: "REGISTER", atSim: AT, real: "2026-10-09T12:00:02.000Z", seq: 1, id: "reg-1", item: "filed" },
      { type: "MESSAGE", direction: "IN", atSim: AT, real: "2026-10-09T12:00:01.000Z", messageId: "m-in", id: "m-in", item: "customer" },
    ]);
    expect(items).toEqual(["customer", "filed", "ack"]);
  });

  it("[FL-017] without a real stamp the customer's message comes first and each tape decision sits right before its message", () => {
    const items = orderTimeline([
      { type: "ACTION", atSim: AT, id: "aud-1", item: "tool" },
      { type: "MESSAGE", direction: "OUT", atSim: AT, messageId: "m-2", id: "m-2", item: "answer" },
      { type: "MESSAGE", direction: "OUT", atSim: AT, messageId: "m-1", id: "m-1", item: "ack" },
      { type: "TAPE", atSim: AT, seq: 2, messageId: "m-2", id: "tp-2", item: "tape answer" },
      { type: "TAPE", atSim: AT, seq: 1, messageId: "m-1", id: "tp-1", item: "tape ack" },
      { type: "MESSAGE", direction: "IN", atSim: AT, messageId: "m-0", id: "m-0", item: "customer" },
    ]);
    expect(items).toEqual(["customer", "tape ack", "ack", "tape answer", "answer", "tool"]);
  });

  it("keeps the simulated time first: a later minute never comes before an earlier one", () => {
    const items = orderTimeline([
      { type: "MESSAGE", direction: "IN", atSim: "2026-10-07T10:11:00-03:00", real: "2026-10-09T12:00:00.000Z", id: "b", item: "later" },
      { type: "MILESTONE", atSim: AT, id: "a", item: "earlier" },
    ]);
    expect(items).toEqual(["earlier", "later"]);
  });

  it("[FL-017] a status change sits right after the register entry that recorded it; a milestone after every stamped row of its minute", () => {
    const items = orderTimeline(TURNS);
    expect(items).toEqual(EXPECTED);
  });

  it("[FL-017] mixed rows with and without a real stamp over four turns: the same order whatever the input order", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const seen = new Set<string>();
    for (let round = 0; round < 500; round += 1) {
      const shuffled = [...TURNS];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other] as Row, shuffled[index] as Row];
      }
      seen.add(orderTimeline(shuffled).join("|"));
    }
    expect([...seen]).toEqual([EXPECTED.join("|")]);
  });

  it("[FL-017] with one fixed real instant per customer message (a fixed clock), a reply never comes before the question it answers", () => {
    const at = (second: number) => `2026-10-09T12:00:${String(second).padStart(2, "0")}.000Z`;
    const items = orderTimeline([
      { type: "MESSAGE", direction: "OUT", atSim: AT, real: at(2), messageId: "m-ok", id: "m-ok", item: "Listo, te escribo a ese email" },
      { type: "MESSAGE", direction: "IN", atSim: AT, real: at(2), messageId: "m-yes", id: "m-yes", item: "Sí, a ese email" },
      { type: "MESSAGE", direction: "OUT", atSim: AT, real: at(1), messageId: "m-ch", id: "m-ch", item: "¿Qué día vence tu cuota?" },
      { type: "MESSAGE", direction: "IN", atSim: AT, real: at(1), messageId: "m-q", id: "m-q", item: "Pagué la cuota 4" },
      { type: "MESSAGE", direction: "IN", atSim: AT, real: at(3), messageId: "m-d", id: "m-d", item: "5/10" },
    ]);
    expect(items).toEqual(["Pagué la cuota 4", "¿Qué día vence tu cuota?", "Sí, a ese email", "Listo, te escribo a ese email", "5/10"]);
  });

  it("pairs each status change with the register entry of the same new status and instant, each entry once", () => {
    const register = [
      { id: "reg-2", seq: 2, status: "INVESTIGATING", atSim: AT },
      { id: "reg-1", seq: 1, status: "REGISTERED", atSim: AT },
      { id: "reg-3", seq: 3, status: null, atSim: AT },
    ];
    expect(pairStatusChanges([{ to: "REGISTERED", atSim: AT }, { to: "INVESTIGATING", atSim: AT }, { to: "INVESTIGATING", atSim: AT }], register)).toEqual(["reg-1", "reg-2", undefined]);
  });
});

type Row = TimelineEntry<string>;
const real = (second: number) => `2026-10-09T12:00:${String(second).padStart(2, "0")}.000Z`;

/** Four turns of one paused minute, as the router concatenates them (messages, tape, actions, milestones, register, status). */
const TURNS: readonly Row[] = [
  { type: "MESSAGE", direction: "IN", atSim: AT, real: real(1), messageId: "m-1", id: "m-1", item: "IN complaint" },
  { type: "MESSAGE", direction: "OUT", atSim: AT, real: real(4), messageId: "m-2", id: "m-2", item: "OUT ack" },
  { type: "MESSAGE", direction: "IN", atSim: AT, real: real(10), messageId: "m-3", id: "m-3", item: "IN consent" },
  { type: "MESSAGE", direction: "OUT", atSim: AT, real: real(12), messageId: "m-4", id: "m-4", item: "OUT challenge" },
  { type: "MESSAGE", direction: "IN", atSim: AT, real: real(20), messageId: "m-5", id: "m-5", item: "IN answer" },
  { type: "MESSAGE", direction: "OUT", atSim: AT, real: real(24), messageId: "m-6", id: "m-6", item: "OUT investigating" },
  { type: "MESSAGE", direction: "IN", atSim: AT, real: real(30), messageId: "m-7", id: "m-7", item: "IN thanks" },
  { type: "TAPE", atSim: AT, real: real(3), seq: 1, messageId: "m-2", id: "tp-1", item: "TAPE ack" },
  { type: "TAPE", atSim: AT, real: real(11), seq: 2, messageId: "m-4", id: "tp-2", item: "TAPE challenge" },
  { type: "TAPE", atSim: AT, real: real(23), seq: 3, messageId: "m-6", id: "tp-3", item: "TAPE investigating" },
  { type: "ACTION", atSim: AT, real: real(21), id: "aud-1", item: "ACTION verify" },
  { type: "ACTION", atSim: AT, real: real(31), id: "aud-2", item: "ACTION note" },
  { type: "MILESTONE", atSim: AT, id: "tmr-1", item: "MILESTONE" },
  { type: "REGISTER", atSim: AT, real: real(2), seq: 1, id: "reg-1", item: "REGISTER filed" },
  { type: "REGISTER", atSim: AT, real: real(22), seq: 2, id: "reg-2", item: "REGISTER investigating" },
  { type: "STATUS", atSim: AT, seq: 0, follows: "reg-1", id: "status-0", item: "STATUS Registrado" },
  { type: "STATUS", atSim: AT, seq: 1, follows: "reg-2", id: "status-1", item: "STATUS En investigación" },
];

const EXPECTED = [
  "IN complaint",
  "REGISTER filed",
  "STATUS Registrado",
  "TAPE ack",
  "OUT ack",
  "IN consent",
  "TAPE challenge",
  "OUT challenge",
  "IN answer",
  "ACTION verify",
  "REGISTER investigating",
  "STATUS En investigación",
  "TAPE investigating",
  "OUT investigating",
  "IN thanks",
  "ACTION note",
  "MILESTONE",
];
