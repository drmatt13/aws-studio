import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { frameworkRepositoryRoot } from "aws-studio/config/source";
import { emitClientAccess } from "./emit-client-access.js";

async function generate() {
  const database = path.join(frameworkRepositoryRoot(), "packages/database");
  const local = createRequire(path.join(database, "package.json"));
  const manifestPath = local.resolve("prisma/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.prisma;
  if (!entry) throw new Error("The selected database package requires a Prisma installation with a CLI.");
  const result = spawnSync(process.execPath, [path.resolve(path.dirname(manifestPath), entry), "contract", "emit", ...process.argv.slice(2)], {
    cwd: database, stdio: "inherit", windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  await emitClientAccess(database);
  return 0;
}

try { process.exitCode = await generate(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
