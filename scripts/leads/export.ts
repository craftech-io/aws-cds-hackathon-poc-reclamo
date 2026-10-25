// Export of the leads of the self-signup for Craftech (docs/architecture-guests.md §10, FL-127). An
// operator runs it with the account's profile, never CI:
//
//   npm run leads:export -- --out ~/leads/reclamo-2026-10.csv          only leads that accepted contact
//   npm run leads:export -- --out ~/leads/reclamo-all.csv --all        every lead
//   npm run leads:export -- --out scripts/leads/leads.local.csv         inside the repo only as *.local.csv
//
// CSV with every cell escaped (a cell that starts with = + - @ is prefixed so a spreadsheet never runs
// it). QA leads are never exported. Nothing it prints names a person: only the count and the path.
// The email of a lead is personal data: the file is the operator's responsibility (Ley 25.326).
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isTestLead, type Lead } from "../../packages/bff/src/leads/records";
import { parseFlags } from "../channels/cli-args";
import { scanLeads } from "./dynamo";

export interface ExportArgs {
  readonly out: string;
  readonly all: boolean;
}

export function parseExportArgs(argv: readonly string[]): ExportArgs {
  let out: string | undefined;
  let all = false;
  parseFlags(argv, {
    "--out": (value) => {
      out = value();
    },
    "--all": () => {
      all = true;
    },
  });
  if (!out) throw new RangeError("--out <path> is required");
  return { out, all };
}

/** A path inside the repository is accepted only as `*.local.csv` (ignored by git). */
export function assertOutsideRepo(out: string, repoRoot: string): string {
  const path = resolve(out);
  const inside = !relative(repoRoot, path).startsWith("..") && !relative(repoRoot, path).startsWith("/");
  if (inside && !path.endsWith(".local.csv")) throw new RangeError("inside the repository the export must be a *.local.csv file");
  return path;
}

/** One CSV cell: quoted, quotes doubled, formula starters neutralized, line breaks flattened. */
export function csvCell(value: string | number | boolean | undefined): string {
  const text = value === undefined ? "" : String(value);
  const flat = text.replace(/[\r\n]+/g, " ");
  const safe = /^[=+\-@\t]/.test(flat) ? `'${flat}` : flat;
  return `"${safe.replaceAll('"', '""')}"`;
}

export const CSV_COLUMNS = [
  "email",
  "name",
  "company",
  "jobTitle",
  "contactAccepted",
  "contactAcceptedAtReal",
  "termsAcceptedAtReal",
  "consentTextVersion",
  "sourcePoc",
  "locale",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "referrer",
  "signupAtReal",
  "confirmedAtReal",
  "lastLoginAtReal",
] as const;

function row(lead: Lead): string {
  const cells = [
    lead.email,
    lead.name,
    lead.company,
    lead.jobTitle,
    lead.consents.contact.accepted,
    lead.consents.contact.atReal,
    lead.consents.terms.acceptedAtReal,
    lead.consents.terms.textVersion,
    lead.sourcePoc,
    lead.locale,
    lead.utm?.source,
    lead.utm?.medium,
    lead.utm?.campaign,
    lead.referrer,
    lead.signupAtReal,
    lead.confirmedAtReal,
    lead.lastLoginAtReal,
  ];
  return cells.map(csvCell).join(",");
}

/** The CSV of the leads to export: with contact consent unless `all`, never a QA lead. */
export function leadsCsv(leads: readonly Lead[], all: boolean): { readonly csv: string; readonly count: number } {
  const chosen = leads.filter((lead) => !isTestLead(lead) && (all || lead.consents.contact.accepted)).sort((a, b) => a.confirmedAtReal.localeCompare(b.confirmedAtReal));
  return { csv: [CSV_COLUMNS.map(csvCell).join(","), ...chosen.map(row)].join("\n") + "\n", count: chosen.length };
}

export async function exportLeads(args: ExportArgs, source: () => AsyncIterable<Lead>, repoRoot: string, write = writeFileSync): Promise<{ readonly path: string; readonly count: number }> {
  const path = assertOutsideRepo(args.out, repoRoot);
  const leads: Lead[] = [];
  for await (const lead of source()) leads.push(lead);
  const { csv, count } = leadsCsv(leads, args.all);
  write(path, csv, { encoding: "utf8", mode: 0o600 });
  return { path, count };
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseExportArgs(process.argv.slice(2));
    const { path, count } = await exportLeads(args, scanLeads, REPO_ROOT);
    console.log(`leads:export: ${count} lead(s) written to ${path}${args.all ? " (all leads)" : " (contact accepted)"}.`);
  } catch (error) {
    console.error(`leads:export: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
