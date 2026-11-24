import assert from "./support/assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { domainOutcome } from "../server/operations/adapter";
import { OperationsClient } from "../server/operations/client";
import { startCoordinator } from "../server/operations/coordinator";
import { closeIpcAuthentication, privateEndpoint } from "../server/operations/ipc";
import { OperationStore } from "../server/operations/store";
import { needsTeardownProjection, projectTeardownOutcome, verifiedTeardownOutcome } from "../server/operations/teardown-outcome";
import type { OperationIntent, OperationRecord } from "../shared/operations";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-teardown-outcome-")));
  const state = path.join(root, "state"), file = path.join(state, "teardowns", "delete-fixture.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const review = { version: 1, createdAt: "2026-11-08T18:00:00.000Z", expiresAt: "2026-11-08T18:15:00.000Z",
    digest: "a".repeat(64), deployment: "fixture-dev", mode: "dev", account: "123456789012", region: "us-east-1",
    policy: { retainFailed: false, disableProtection: false }, blockers: [], warnings: [],
    stacks: ["Api", "Data"].map(name => ({ name: `fixture-dev-${name}`, id: `arn:aws:cloudformation:us-east-1:123456789012:stack/fixture-dev-${name}/immutable-id`,
      status: "CREATE_COMPLETE", templateDigest: "b".repeat(64), failedResources: [], terminationProtection: false, importedBy: [] })),
    leftInPlace: [], remains: [{ stack: "fixture-dev-Data", logicalId: "Logs", type: "AWS::Logs::LogGroup", policy: "Retain" }],
    secrets: ["fixture-secret-name"], record: true };
  const text = JSON.stringify(review);
  writeFileSync(file, text);
  const params = { deployment: review.deployment, mode: "dev", profile: "fixture", region: review.region };
  const intent: OperationIntent = { version: 1, workspace: root, locks: [], consumptionKey: "destroy:delete-fixture",
    request: { kind: "destroy", params: { ...params, review: "delete-fixture", confirm: review.deployment } },
    binding: createHash("sha256").update(JSON.stringify(text)).digest("hex"),
    view: { kind: "destroy", title: "Delete fixture-dev", params, deployment: review.deployment, steps: [] } };
  const receipt = { digest: review.digest, deployment: review.deployment, account: review.account, region: review.region,
    state: "succeeded", completed: review.stacks.map(stack => stack.id), updatedAt: "2026-11-08T18:20:00.000Z" };
  const save = (value: unknown = receipt) => writeFileSync(file + ".result.json", JSON.stringify(value));
  save();
  const record: OperationRecord = { intent, view: { ...intent.view, id: "delete-operation", status: "succeeded", execution: "finished",
    outcome: "unverified", startedAt: review.createdAt, endedAt: receipt.updatedAt, exitCode: 0, lastSeq: 0,
    summary: "fixture-dev is deleted.", recovery: "Inspect the teardown receipt and AWS to verify the final resource state." } };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, state, file, review, receipt, intent, record, save };
}

test("a matching complete receipt confirms deletion of all reviewed stacks, separately from retained resources", t => {
  const f = fixture(t);
  const result = domainOutcome(f.state, f.intent);
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.summary, "All 2 reviewed stacks deleted.");
  assert.equal(result.recovery, undefined);
  assert.equal(result.completionDetail, "CloudFormation verified deletion in 123456789012 · us-east-1. Retained resources and managed secrets are separate.");
  // Review expiry prevents another execution, not reading evidence of a finished one.
  assert.ok(Date.parse(f.receipt.updatedAt) > Date.parse(f.review.expiresAt));
});

test("missing, malformed, partial or differently scoped receipts never turn successful exit into verified deletion", t => {
  const f = fixture(t);
  for (const patch of [
    { digest: "c".repeat(64) }, { deployment: "foreign-dev" }, { account: "999999999999" }, { region: "us-west-2" },
    { state: "failed" }, { state: "running" }, { pending: f.receipt.completed[0] }, { problem: "Retained evidence could not be recorded." },
    { completed: [] }, { completed: [f.receipt.completed[0]] }, { completed: [...f.receipt.completed, "foreign-id"] },
    { completed: [f.receipt.completed[0], f.receipt.completed[0]] }, { completed: "not-an-array" }, { completed: undefined },
    { updatedAt: "unreadable" }, { updatedAt: "2026-11-07T00:00:00.000Z" },
  ]) {
    f.save({ ...f.receipt, ...patch });
    assert.equal(verifiedTeardownOutcome(f.state, f.intent), undefined, JSON.stringify(patch));
    assert.equal(domainOutcome(f.state, f.intent).outcome, "unverified");
    assert.equal(projectTeardownOutcome(f.state, f.record), f.record.view);
  }
  writeFileSync(f.file + ".result.json", "not JSON");
  assert.equal(verifiedTeardownOutcome(f.state, f.intent), undefined);
  rmSync(f.file + ".result.json");
  const missing = domainOutcome(f.state, f.intent);
  assert.equal(missing.outcome, "unverified");
  assert.match(missing.summary!, /could not be confirmed/);
  assert.match(missing.recovery!, /matching this deletion review is unavailable/);
});

test("receipt verification is bound to accepted review bytes and destination, never a receipt alone", t => {
  const f = fixture(t);
  for (const intent of [
    { ...f.intent, binding: undefined }, { ...f.intent, binding: "other" },
    { ...f.intent, version: 2 as 1 },
    { ...f.intent, request: { ...f.intent.request, kind: "deploy-apply" as const } },
    { ...f.intent, request: { ...f.intent.request, params: { ...f.intent.request.params, deployment: "foreign-dev" } } },
    { ...f.intent, request: { ...f.intent.request, params: { ...f.intent.request.params, mode: "prod" } } },
    { ...f.intent, request: { ...f.intent.request, params: { ...f.intent.request.params, region: "us-west-2" } } },
    { ...f.intent, request: { ...f.intent.request, params: { ...f.intent.request.params, review: "../delete-fixture" } } },
    { ...f.intent, view: { ...f.intent.view, deployment: "foreign-dev" } },
    { ...f.intent, view: { ...f.intent.view, params: { ...f.intent.view.params, mode: "prod" } } },
  ]) assert.equal(verifiedTeardownOutcome(f.state, intent), undefined);
  writeFileSync(f.file, JSON.stringify({ ...f.review, stacks: f.review.stacks.slice(0, 1) }));
  assert.equal(verifiedTeardownOutcome(f.state, f.intent), undefined, "editing the accepted review cannot shrink the scope of proof");
  rmSync(f.file);
  assert.equal(verifiedTeardownOutcome(f.state, f.intent), undefined);
});

test("historical projection preserves raw evidence and never promotes lost, failed, cancelled or unfinished execution", t => {
  const f = fixture(t), before = JSON.stringify(f.record), review = readFileSync(f.file, "utf8"), receipt = readFileSync(f.file + ".result.json", "utf8");
  const projected = projectTeardownOutcome(f.state, f.record);
  assert.equal(projected.outcome, "confirmed");
  assert.equal(projected.execution, "finished");
  assert.equal(projected.recovery, undefined);
  assert.equal(JSON.stringify(f.record), before);
  assert.equal(readFileSync(f.file, "utf8"), review);
  assert.equal(readFileSync(f.file + ".result.json", "utf8"), receipt);
  for (const patch of [
    { status: "failed" as const }, { status: "running" as const }, { status: "cancelled" as const }, { status: "interrupted" as const },
    { execution: "lost" as const }, { execution: undefined }, { exitCode: 1 }, { exitCode: undefined },
    { outcome: "uncertain" as const }, { kind: "deploy-apply" as const },
  ]) {
    const record = { ...f.record, view: { ...f.record.view, ...patch } };
    assert.equal(needsTeardownProjection(record.view), false);
    assert.equal(projectTeardownOutcome(f.state, record), record.view);
  }
  for (const patch of [{ deployment: "foreign-dev" }, { params: { ...f.record.view.params, deployment: "foreign-dev" } }, { params: { ...f.record.view.params, mode: "prod" } }]) {
    const record = { ...f.record, view: { ...f.record.view, ...patch } };
    assert.equal(projectTeardownOutcome(f.state, record), record.view, "projection also preserves the displayed destination");
  }
});

test("client list, detail and log agree on historical deletion without changing the coordinator journal or consumed review", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const store = new OperationStore(path.join(f.state, "operations"));
  store.bindWorkspace(f.root);
  const job = store.accept(f.intent, "fixture-delete-request");
  store.update(job.id, { ...f.record.view, id: job.id });
  const line = store.append(job.id, "All reviewed stacks are deleted. Retained resources are separate.");
  const original = store.get(job.id)!;
  const coordinator = await startCoordinator(f.root, f.state), client = new OperationsClient(f.root, f.state);
  try {
    const listed = (await client.list())[0]!;
    const detail = (await client.get(job.id))!.view;
    const log = await client.log(job.id);
    assert.equal(listed.outcome, "confirmed");
    assert.deepEqual(detail, listed);
    assert.deepEqual(log.job, listed);
    assert.deepEqual(log.lines, [line]);
    assert.deepEqual(store.get(job.id), original);
    assert.throws(() => store.accept(f.intent, "another-delete-request"), /consumed|already/);
    f.save({ ...f.receipt, state: "failed" });
    assert.equal((await client.list())[0]!.outcome, "unverified", "proof is reread, not cached as success");
  } finally {
    client.close(); await coordinator.close(); store.close();
    const endpoint = privateEndpoint(f.root, f.state);
    closeIpcAuthentication(endpoint.socket);
    rmSync(endpoint.directory, { recursive: true, force: true });
  }
});
