import assert from "./support/assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDevelopmentObservation } from "aws-studio/cli/dev-observation";
import { Tools } from "../server/deploy/process";

// Studio's Deploy & Run tools: moved from the cdk-app suite so the platform's own suites run without Studio.
async function fixture() {
  const root = await mkdtemp(
    path.join(realpathSync(tmpdir()), "studio-log-startup-"),
  );
  await mkdir(path.join(root, "cdk-app"));
  await writeFile(
    path.join(root, ".env"),
    "LOCAL_FRAMEWORK_DEPLOYMENT=fixture-dev\nLOCAL_FRAMEWORK_ACCOUNT=000000000000\nLOCAL_AWS_REGION=us-east-1\n",
  );
  await writeFile(
    path.join(root, "cdk-app/.env.dev"),
    "FIXTURE_PASSWORD=startup-secret-canary\n",
  );
  await writeFile(
    path.join(root, "docker-compose.yml"),
    "include: [docker-compose.services.yml]\nservices:\n  local-invocation-runner: { image: fixture }\n  local-api-dev-server: { image: fixture }\n",
  );
  await writeFile(
    path.join(root, "docker-compose.services.yml"),
    "services:\n  fixture-service: { image: fixture }\n",
  );
  await writeFile(
    path.join(root, "framework.config.ts"),
    "export default {};\n",
  );
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("Tools resolves diagnostics from the command project, never another checkout", async () => {
  const a = await fixture(), b = await fixture(), unrelated = await fixture();
  try {
    const one = await prepareDevelopmentObservation(a.root);
    const two = await prepareDevelopmentObservation(b.root);
    assert.equal(one.enabled, true); assert.equal(two.enabled, true);
    const tools = new Tools(path.resolve(__dirname, "../.."), {});
    const args = ["compose", "config", "--format", "json"];
    for (const [f, prepared, other] of [[a, one, two], [b, two, one]] as const) {
      const spec = tools.docker(args, {}, f.root);
      assert.equal(spec.cwd, f.root);
      assert.ok(spec.args.includes(prepared.overlay!));
      assert.ok(!spec.args.includes(other.overlay!));
      assert.ok(!spec.args.includes(path.join(tools.root, ".framework/local/development-logs.compose.json")));
    }
    const foreign = tools.docker(args, {}, unrelated.root);
    assert.equal(foreign.cwd, unrelated.root);
    assert.deepEqual(foreign.args, args);
  } finally { await a.dispose(); await b.dispose(); await unrelated.dispose(); }
});
