// Flag parsing of the operator scripts (whatsapp-templates.ts, waba-event-destination.ts,
// console/invite.ts, smoke/interim.ts): `--name` switches and
// `--name <value>` options, a handler per flag, and a RangeError for a missing value or an unknown
// flag, so a typo never turns a read-only run into a write.

/** Reads the value that follows the flag being handled. */
export type FlagValue = () => string;

export type FlagHandlers = Readonly<Record<string, (value: FlagValue) => void>>;

export function parseFlags(argv: readonly string[], handlers: FlagHandlers): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const value: FlagValue = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new RangeError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    const handle = Object.hasOwn(handlers, arg) ? handlers[arg] : undefined;
    if (!handle) throw new RangeError(`unknown argument "${arg}"`);
    handle(value);
  }
}
