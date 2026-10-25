// How the landing's scripts run as commands: only when the file is the entry point (the tests import
// them), exiting 0 when done (the browsers and servers they started are closed by then) and 1 with
// the error's message, never its stack.
import { resolve } from "node:path";

export function runAsCommand(name: string, entry: string, main: () => Promise<void>): void {
  if (!process.argv[1] || resolve(process.argv[1]) !== entry) return;
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
