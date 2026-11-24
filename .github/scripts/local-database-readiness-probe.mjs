import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { platformRoot } from "../../scripts/test-project-source.mjs";

// Test-only entrypoint. The smoke driver starts this with --import tsx so it
// exercises Studio's real read-only readiness checker and native Docker runner.
const [mode, sourceRoot, application, postgres, verifier] = process.argv.slice(2);
assert.ok(sourceRoot && path.isAbsolute(sourceRoot) && application && path.isAbsolute(application),
  "Both fixture paths must be absolute.");
if (mode === "copy-source") {
  const { configurationSourceFiles } = await import("aws-studio/database/configuration-inputs");
  const { databaseInputsDigest, databaseMigrationSourceFiles } = await import("aws-studio/database/studio-migrations");
  const expected = databaseInputsDigest(application);
  const files = new Set([...configurationSourceFiles(application), ...databaseMigrationSourceFiles(application)]);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const relative = path.relative(application, file);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const destination = path.join(sourceRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(file, destination);
  }
  cpSync(path.join(application, "packages/database/prisma"), path.join(sourceRoot, "packages/database/prisma"), { recursive: true });
  assert.equal(databaseInputsDigest(sourceRoot), expected, "The source fixture copies the exact reviewed Prisma input closure.");
  console.log(JSON.stringify({ copied: true }));
} else {
  assert.equal(mode, "problem");
  assert.ok(postgres && verifier);
  const { LocalDatabaseReadiness } = await import("../../client-app/server/deploy/database-readiness.ts");
  const { Tools, runCommand } = await import("../../client-app/server/deploy/process.ts");
  const checker = new LocalDatabaseReadiness(sourceRoot, new Tools(platformRoot, process.env), runCommand, process.env);
  const problem = await checker.problem(postgres, verifier);
  console.log(JSON.stringify({ problem: problem ?? null }));
}
