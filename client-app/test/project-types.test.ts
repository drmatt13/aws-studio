import assert from "./support/assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resourceTypeErrors } from "../server/resources-source";

test("source review resolves ambient types from the external CDK workspace", () => {
  const project = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-project-types-"));
  try {
    const cdk = path.join(project, "cdk-app");
    const ambient = path.join(cdk, "node_modules/@types/project-review-fixture");
    mkdirSync(ambient, { recursive: true });
    writeFileSync(path.join(ambient, "index.d.ts"), 'declare const projectReviewValue: "selected-project";\n');
    writeFileSync(path.join(cdk, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "es2022", module: "NodeNext", types: ["project-review-fixture"], strict: true,
    } }));
    const source = path.join(project, "framework.config.ts");
    assert.deepEqual(resourceTypeErrors(project, { [source]: 'export const verified: "selected-project" = projectReviewValue;' }), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
