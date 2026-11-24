import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalSpike } from "./support/private-dns-parity/cli";

test("an existing evidence directory is preserved and refused before any Docker operation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "phz-evidence-preservation-"));
  const journal = path.join(directory, "resources.json");
  const original = JSON.stringify({ previousRun: true });
  try {
    await writeFile(journal, original);
    await assert.rejects(runLocalSpike(["--output", directory]), /output directory already exists/);
    assert.equal(await readFile(journal, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real Docker DNS and kernel boundaries characterize the PHZ candidate without qualifying AWS equivalence", {
  skip: process.env.FRAMEWORK_PRIVATE_DNS_SPIKE_TEST !== "1",
  timeout: 600_000,
}, async () => {
  const result = await runLocalSpike(process.env.FRAMEWORK_PRIVATE_DNS_SPIKE_BUILD === "1" ? ["--build"] : []);
  assert.equal(result.status, "local-characterized");
  assert.equal(result.releaseAuthorized, false);
  const report = JSON.parse(await readFile(path.join(result.directory, "report.json"), "utf8"));
  assert.equal(report.qualification.status, "no-go");
  assert.ok(report.qualification.reasons.some((reason: string) => /AWS.*missing|missing.*AWS/i.test(reason)));
  assert.deepEqual(report.cleanupFailures, []);
  assert.ok(report.checks.length > 10);
  assert.ok(report.checks.every((check: { passed: boolean }) => check.passed));
});
