// Política de canal (docs/design-brief.md §7 and §9; ADR-0002; ADR-0017; FL-075): the rules the
// outbound gate decides with, in order, with their version, their English gloss and "nuestra lectura,
// no asesoramiento legal"; the world's channel modes and parameters; and the agent cut-off, which a
// SUPERVISOR of `demo` can turn on or off. Every other role reads it.
import { Badge } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { RuleChip } from "../../components/RuleChip";
import { Section } from "../../components/Section";
import { Table, type Column } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { useRemote } from "../../lib/use-remote";
import { AgentKill } from "./AgentKill";
import { policyCopy } from "./copy";
import { type PolicyModes, type PolicyRules, type WorldParameters, capLines, parameterRows } from "./policy-model";

type Rule = PolicyRules["rules"][number];

const RULE_COLUMNS: readonly Column<Rule>[] = [
  { id: "rule", header: policyCopy.rules.rule, cell: (rule) => <RuleChip ruleId={rule.ruleId} /> },
  {
    id: "what",
    header: policyCopy.rules.what,
    cell: (rule) => (
      <span className="block max-w-xl">
        <span className="block font-semibold text-ink">{rule.short}</span>
        <span className="block text-sm text-slate">{rule.detail}</span>
      </span>
    ),
  },
  {
    id: "gloss",
    header: policyCopy.rules.gloss,
    cell: (rule) => (
      <span lang="en" className="block max-w-md text-sm text-slate">
        <span className="block font-semibold text-ink">{rule.gloss.short}</span>
        {rule.gloss.detail}
      </span>
    ),
  },
];

function Versions({ rules }: { readonly rules: PolicyRules }) {
  const v = policyCopy.versions;
  return (
    <dl aria-label={v.title} className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {[
        [v.policy, rules.policyVersion],
        [v.rules, rules.ruleSetVersion],
        [v.lexicon, rules.lexiconVersion],
      ].map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="font-semibold text-slate">{label}</dt>
          <dd>
            <code className="font-mono text-ink">{value}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Modes({ modes }: { readonly modes: PolicyModes }) {
  const m = policyCopy.modes;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{m.email}</dt>
        <dd className="mt-1 text-sm text-ink">{m.emailMode}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{m.whatsapp}</dt>
        <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink">
          <Badge tone={modes.whatsapp === "live" ? "success" : "info"}>{modes.whatsapp === "live" ? m.live : m.simulated}</Badge>
          <span className="text-xs text-slate">{modes.stageAllowsLiveWhatsApp ? m.stageLive : m.stageNotLive}</span>
        </dd>
      </div>
    </dl>
  );
}

function Parameters({ parameters }: { readonly parameters: WorldParameters | null }) {
  const p = policyCopy.parameters;
  if (parameters === null) return <p className="text-sm text-slate">{p.none}</p>;
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
        {parameterRows(parameters).map((row) => (
          <div key={row.label} className="flex flex-wrap justify-between gap-2 border-b border-mist py-1.5 text-sm">
            <dt className="text-slate">{row.label}</dt>
            <dd className="flex items-center gap-2 font-medium text-ink">
              {row.value}
              {row.assumption ? <Badge tone="warning">{p.assumption}</Badge> : null}
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="text-sm font-semibold text-pine">{p.caps}</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {capLines(parameters).map((line) => (
            <li key={line.action}>
              <span className="font-medium text-ink">{line.action}:</span> <span className="text-slate">{line.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function PolicyView() {
  const { trpc } = useSession();
  const view = consoleCopy.views.policy;
  const rules = useRemote("policy.rules", (signal) => trpc.policy.rules.query(undefined, { signal }));
  const modes = useRemote("policy.modes", (signal) => trpc.policy.modes.query(undefined, { signal }));

  return (
    <div className="space-y-6">
      <PageHeader title={view.title} description={view.description} />
      <RemoteBlock state={rules.state} onRetry={rules.reload}>
        {(data) => (
          <div className="space-y-6">
            <Callout tone="neutral" title={data.notLegalAdvice.es}>
              <span lang="en">{data.notLegalAdvice.en}</span>
            </Callout>
            <Versions rules={data} />
          </div>
        )}
      </RemoteBlock>
      <Section id="policy-agent" title={policyCopy.kill.title}>
        <RemoteBlock state={modes.state} onRetry={modes.reload}>
          {(data) => <AgentKill modes={data} onChanged={modes.reload} />}
        </RemoteBlock>
      </Section>
      <Section id="policy-modes" title={policyCopy.modes.title}>
        <RemoteBlock state={modes.state} onRetry={modes.reload}>
          {(data) => <Modes modes={data} />}
        </RemoteBlock>
      </Section>
      <Section id="policy-rules" title={policyCopy.rules.title} description={policyCopy.rules.lead}>
        <RemoteBlock state={rules.state} onRetry={rules.reload}>
          {(data) => <Table variant="inset" columns={RULE_COLUMNS} rows={data.rules} keyOf={(rule) => rule.ruleId} emptyTitle={policyCopy.rules.title} caption={policyCopy.rules.caption} />}
        </RemoteBlock>
      </Section>
      <Section id="policy-parameters" title={policyCopy.parameters.title} description={policyCopy.parameters.lead}>
        <RemoteBlock state={rules.state} onRetry={rules.reload}>
          {(data) => <Parameters parameters={data.parameters} />}
        </RemoteBlock>
      </Section>
    </div>
  );
}
