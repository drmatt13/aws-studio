import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { platformSourceRoot, testProjectRoot } from "../../../scripts/test-project";

const databaseModules = [
  "client-access",
  "access-graph",
  "access-syntax",
  "access-rules",
  "access-graph-artifact",
  "studio-migrations",
  "studio-migrations-types",
  "configuration-inputs",
  "empty-database",
  "access-runtime",
] as const;

test("the database access and migration modules are framework exports", () => {
  for (const module of databaseModules) {
    const specifier = `aws-studio/database/${module}`;
    assert.equal(require.resolve(specifier), path.join(platformSourceRoot, "packages/aws-studio/database", `${module}.ts`));
    for (const folder of ["scripts", "src"]) {
      const oldFile = path.join("packages/database", folder, `${module}.ts`);
      assert.ok(!existsSync(path.join(platformSourceRoot, oldFile)), `${oldFile} should have moved`);
      assert.ok(!existsSync(path.join(testProjectRoot, oldFile)), `The starter must use the release's ${module} export`);
    }
  }
});

test("each image provides a workspace release or the app's vendored archive before npm installs its package bin", () => {
  const dockerfiles = [
    [platformSourceRoot, "packages/aws-studio/dev/Dockerfile"],
    [testProjectRoot, "compute/tasks/db-migrate/Dockerfile"],
    [testProjectRoot, "compute/tasks/invocation-test-task/Dockerfile"],
  ] as const;
  for (const [root, file] of dockerfiles) {
    const source = readFileSync(path.join(root, file), "utf8").replace(/\\\r?\n/g, " ");
    const stages = source.split(/^FROM /m);
    const inputs = stages.find(stage => /^node:[^\n]+ AS release-inputs$/m.test(stage));
    const final = stages.at(-1)!;
    assert.ok(inputs, `${file} must prepare the release from the app's build context`);
    assert.match(inputs, /\/app\/packages\/aws-studio\/package.json/);
    assert.match(inputs, /cp -R package\.json .*\bcli\b.*\bdatabase\b/);
    assert.match(inputs, /require\("\/app\/package.json"\)\.dependencies\?\.\["aws-studio"\]/);
    assert.match(inputs, /fs\.copyFileSync\("\/app\/" \+ file, file\)/);
    const staged = final.indexOf("COPY --from=release-inputs /install/ ./");
    const install = final.indexOf("npm ci ");
    assert.ok(staged >= 0 && staged < install, `${file} must provide the pin before npm ci`);
    assert.match(final.slice(0, install), /COPY --parents \.nvmrc package\.json package-lock\.json/);
    assert.doesNotMatch(final, /^COPY packages\/aws-studio\//m, "An installed app has no release source workspace.");
    if (file.includes("db-migrate")) {
      assert.ok(final.indexOf("db:copy-configuration-inputs /source /workspace") > install);
    }
    if (!file.includes("invocation-test-task")) {
      assert.ok(final.indexOf("npm --workspace @repo/database run generate") > install);
    }
  }
});
