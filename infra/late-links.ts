// Links to Linkables owned by modules that would close an import cycle if imported statically.
//
// Example: the inbound and tool Lambdas link the timers of infra/scheduler.ts and the queues of
// infra/workers.ts, while those modules link the channel Linkables of infra/messaging-*.ts. A
// static import in either direction closes a cycle, so the consumer resolves those links with a
// dynamic `import()` inside a Pulumi Output: it settles once the owner module has been evaluated,
// whatever the order of sst.config.ts.
//
// `required` links fail the deploy when the owner does not export the name; `optional` ones print a
// warning and the Lambda answers UNAVAILABLE for whatever needs them.

export type LinkList = $util.Output<unknown[]>;

export type LateLinkMode = "required" | "optional";

export function lateLinks(
  consumer: string,
  owner: string,
  load: () => Promise<object>,
  exportNames: readonly string[],
  mode: LateLinkMode = "required",
): LinkList {
  return $util.output(
    load().then((module) =>
      exportNames.flatMap((name) => {
        const value: unknown = Reflect.get(module, name);
        if (value !== undefined) return [value];
        if (mode === "required") throw new Error(`infra/${owner}.ts does not export ${name}, which infra/${consumer}.ts links.`);
        $util.log.warn(`infra/${owner}.ts exports no ${name} yet: the Lambdas of infra/${consumer}.ts that link it answer UNAVAILABLE for what needs it.`);
        return [];
      }),
    ),
  );
}

/** Concatenates static and late link lists into the single Input `link` accepts. */
export function links(...parts: Array<$util.Input<unknown[]>>): LinkList {
  return $util.all(parts).apply((lists) => lists.flat());
}
