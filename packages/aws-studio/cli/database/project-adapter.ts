import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { frameworkRepositoryRoot } from "aws-studio/config/source";

function run() {
  const [name, ...args] = process.argv.slice(2);
  if (name !== "seedTestUser" && name !== "pruneCognitoOrphans") throw new Error("Unknown project database adapter.");
  const root = realpathSync(frameworkRepositoryRoot());
  const entry = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).awsStudio?.database?.[name];
  const invalid = () => new Error(`awsStudio.database.${name} must name a project-relative file inside the selected application.`);
  if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || path.win32.parse(entry).root) throw invalid();
  const contained = (file: string) => {
    const relative = path.relative(root, file);
    return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const declared = path.resolve(root, entry);
  if (!contained(declared) || !existsSync(declared)) throw invalid();
  const file = realpathSync(declared);
  if (!contained(file) || !statSync(file).isFile()) throw invalid();
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), file, ...args], {
    cwd: root, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try { process.exitCode = run(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
