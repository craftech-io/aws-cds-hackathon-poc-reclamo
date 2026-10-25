// Type-checks sst.config.ts and infra/** with tsconfig.infra.json.
//
// SST ships its platform as TypeScript *source* under .sst/platform, and the SST globals used by
// the infra code are declared there, so those files become part of the program. tsc can skip
// declaration files (skipLibCheck) but never .ts sources, and the vendored platform does not
// pass under this repository's compiler options (nor under its own). This runner keeps the full
// strictness for our files and drops the diagnostics whose file lives under .sst/.
import { resolve, sep } from "node:path";
import ts from "typescript";

const cwd = process.cwd();
const configPath = resolve(cwd, "tsconfig.infra.json");
const vendoredRoot = resolve(cwd, ".sst") + sep;

const host: ts.ParseConfigFileHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    console.error(ts.formatDiagnostic(diagnostic, formatHost));
    process.exit(1);
  },
};

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => cwd,
  getNewLine: () => ts.sys.newLine,
};

const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
if (!parsed) {
  console.error(`Could not parse ${configPath}`);
  process.exit(1);
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((diagnostic) => !diagnostic.file || !resolve(diagnostic.file.fileName).startsWith(vendoredRoot));

if (diagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  console.error(`typecheck-infra: ${diagnostics.length} error(s).`);
  process.exit(1);
}

const checked = parsed.fileNames.filter((file) => !resolve(file).startsWith(vendoredRoot)).length;
console.log(`typecheck-infra: ${checked} file(s) checked, no errors.`);
