import assert from "./support/assert";
import { test } from "node:test";
import type { JobView } from "../shared/operations";
import { activityHistory, askAgentPrompt, completedLegacyDiscard, formatDuration, jobOutcome, needsAttention, recoveredLocalFailure, statusLabel, statusTone } from "../src/views/deploy/activity-model";

const NOW = new Date(2026, 10, 6, 15, 0, 0);
let serial = 0;
const job = (patch: Partial<JobView>): JobView => {
  serial++;
  const startedAt = patch.startedAt ?? new Date(NOW.getTime() - serial * 60_000).toISOString();
  return { id: `job-${serial}`, kind: "export", title: `Job ${serial}`, params: {}, status: "succeeded", startedAt, endedAt: startedAt, lastSeq: 1, ...patch };
};
const titles = (groups: ReturnType<typeof activityHistory>) => groups.flatMap(group => group.rows.map(row => row.job.title));

test("running work is pinned above history, however old it is", () => {
  const process = job({ kind: "local-client", title: "Web client", status: "running", endedAt: undefined, startedAt: "2026-10-01T00:00:00.000Z" });
  const recent = Array.from({ length: 40 }, () => job({}));
  const groups = activityHistory([...recent, process], NOW);
  assert.equal(groups[0]!.label, "Running");
  assert.deepEqual(groups[0]!.rows.map(row => row.job.title), ["Web client"]);
});

test("temporary work leads the running group, ahead of steady processes", () => {
  const groups = activityHistory([job({ kind: "local-watch", title: "Source watch", status: "running", endedAt: undefined }), job({ title: "Deploy", kind: "deploy-apply", status: "running", endedAt: undefined })], NOW);
  assert.deepEqual(groups[0]!.rows.map(row => row.job.title), ["Deploy", "Source watch"]);
});

test("container output leads steady processes and remains distinct from pending work", () => {
  const groups = activityHistory([
    job({ kind: "local-client", title: "Web client", status: "running" }),
    job({ kind: "local-logs", title: "Container logs", status: "running" }),
    job({ kind: "local-start", title: "Starting", status: "running" }),
    job({ kind: "local-watch", title: "Source watch", status: "running" }),
  ], NOW);
  assert.deepEqual(groups[0]!.rows.map(row => row.title), ["Starting", "Container logs", "Web client", "Source watch"]);
  assert.equal(statusTone(groups[0]!.rows[1]!.job), "accept");
});

test("successful local retry resolves earlier alerts without rewriting their failures", () => {
  const failed = job({ kind: "local-start", deployment: "app-dev", params: { profile: "dev", account: "123456789012", region: "us-east-1" },
    status: "failed", startedAt: "2026-11-06T10:00:00Z", endedAt: "2026-11-06T10:01:00Z" });
  const retry = job({ ...failed, id: "retry", kind: "local-restart", status: "succeeded", startedAt: "2026-11-06T10:02:00Z", endedAt: "2026-11-06T10:03:00Z" });
  assert.equal(recoveredLocalFailure(failed, [retry, failed]), true);
  assert.equal(needsAttention(failed), true, "history keeps the recorded failure");
  for (const patch of [{ status: "running" as const }, { status: "failed" as const }, { status: "cancelled" as const },
    { deployment: "other-dev" }, { params: { profile: "other" } }, { params: { profile: "dev", account: "999999999999" } },
    { params: { profile: "dev", region: "us-west-2" } }, { outcome: "unverified" as const }, { observationProblem: "Unavailable" },
    { startedAt: "2026-11-06T10:00:30Z" }]) {
    assert.equal(recoveredLocalFailure(failed, [{ ...retry, ...patch }, failed]), false, JSON.stringify(patch));
  }
  assert.equal(recoveredLocalFailure({ ...failed, outcome: "uncertain" }, [retry]), false);
  assert.equal(recoveredLocalFailure({ ...failed, execution: "lost" }, [retry]), false);
  assert.equal(recoveredLocalFailure({ ...failed, kind: "deploy-apply" }, [{ ...retry, kind: "deploy-apply" }]), false);
});

test("a replacement local process clears its failure, while another process cannot", () => {
  const failed = job({ kind: "local-logs", status: "failed", startedAt: "2026-11-06T10:00:00Z", endedAt: "2026-11-06T10:01:00Z" });
  const current = job({ ...failed, id: "current", status: "running", endedAt: undefined, startedAt: "2026-11-06T10:02:00Z" });
  assert.equal(recoveredLocalFailure(failed, [current]), true);
  assert.equal(recoveredLocalFailure(failed, [{ ...current, kind: "local-watch" }]), false);
});

test("identical neighbours collapse, but a different result never hides inside them", () => {
  const groups = activityHistory([job({ title: "Start Docker Desktop" }), job({ title: "Start Docker Desktop" }), job({ title: "Start Docker Desktop", status: "failed" })], NOW);
  assert.deepEqual(groups[0]!.rows.map(row => [row.job.title, row.job.status, row.members.length]), [["Start Docker Desktop", "succeeded", 2], ["Start Docker Desktop", "failed", 1]]);
});

test("each development session collapses into one row bounded by its start", () => {
  const session = () => [job({ kind: "local-stop", title: "Stop development" }), job({ kind: "local-client", title: "Web client", status: "cancelled" }), job({ kind: "local-watch", title: "Source watch", status: "cancelled" }), job({ kind: "local-start", title: "Start development against app", params: { deployment: "app" } })];
  const groups = activityHistory([...session(), ...session(), ...session()], NOW);
  assert.equal(groups.flatMap(group => group.rows).length, 3);
  assert.deepEqual(groups[0]!.rows[0]!.members.map(member => member.title), ["Stop development", "Web client", "Source watch", "Start development against app"]);
  assert.equal(groups[0]!.rows[0]!.title, "Development session");
  assert.equal(groups[0]!.rows[0]!.job.kind, "local-start", "opening a healthy session starts at its startup log");
});

test("a failed step decides what a session row reports", () => {
  const failed = job({ kind: "local-client", title: "Web client", status: "failed" });
  const groups = activityHistory([job({ kind: "local-stop", title: "Stop development" }), failed, job({ kind: "local-start", title: "Start development against app" })], NOW);
  assert.equal(groups[0]!.rows[0]!.job.id, failed.id);
});

test("a lone development job stays an ordinary row", () => {
  const groups = activityHistory([job({ kind: "local-start", title: "Start development against app" })], NOW);
  assert.equal(groups[0]!.rows[0]!.members.length, 1);
  assert.equal(groups[0]!.rows[0]!.title, "Start development against app");
});

test("history splits on the local day it finished", () => {
  const groups = activityHistory([job({ title: "Recent" }), job({ title: "Older", startedAt: "2026-11-01T10:00:00.000Z", endedAt: "2026-11-01T10:05:00.000Z" })], NOW);
  assert.deepEqual(groups.map(group => group.label), ["Today", "Earlier"]);
  assert.deepEqual(titles(groups), ["Recent", "Older"]);
});

test("attention covers what a developer must act on, and an expected stop is not one", () => {
  assert.equal(needsAttention(job({ status: "failed" })), true);
  assert.equal(needsAttention(job({ status: "interrupted", kind: "deploy-apply" })), true);
  assert.equal(needsAttention(job({ outcome: "unverified" })), true);
  assert.equal(needsAttention(job({ status: "interrupted", kind: "local-watch" })), false, "a process stopped with Studio resumes on request");
  assert.equal(needsAttention(job({ status: "cancelled" })), false);
  assert.equal(needsAttention(job({ status: "running", outcome: "uncertain", endedAt: undefined })), false, "it can still resolve");
});

test("each status has one tone", () => {
  assert.equal(statusTone(job({})), "accept");
  assert.equal(statusTone(job({ status: "failed", outcome: "uncertain" })), "refuse");
  assert.equal(statusTone(job({ outcome: "unverified" })), "caution");
  assert.equal(statusTone(job({ status: "interrupted" })), "caution");
  assert.equal(statusTone(job({ status: "cancelled" })), "quiet");
  assert.equal(statusTone(job({ status: "running", endedAt: undefined })), "quiet");
  assert.equal(statusTone(job({ status: "running", kind: "local-client", endedAt: undefined })), "accept");
  assert.equal(statusTone(job({ status: "running", endedAt: undefined, observationProblem: "unknown" })), "caution");
});

test("the outcome leads with what happened, not a generic word", () => {
  assert.equal(jobOutcome(job({}), "Synthesis ready: 75 resource changes to review."), "Synthesis ready: 75 resource changes to review.");
  assert.equal(jobOutcome(job({ status: "failed", steps: [{ label: "Check", status: "done" }, { label: "Apply", status: "failed" }] }), "Exited."), "Failed at Apply");
  assert.equal(jobOutcome(job({ status: "failed" }), undefined), "Failed");
  assert.equal(jobOutcome(job({ outcome: "unverified" }), "Plan discarded."), "Unverified");
  assert.equal(jobOutcome(job({ summary: "Stale startup note." }), undefined), "Done", "the caller decides whether a stored summary still holds");
});

test("verified stack deletion reports Deleted confidently and an unverified deletion still requires attention", () => {
  const deleted = job({ kind: "destroy", status: "succeeded", execution: "finished", outcome: "confirmed", exitCode: 0,
    summary: "All 5 reviewed stacks deleted.", completionDetail: "Retained resources and managed secrets are separate." });
  assert.equal(statusLabel(deleted), "Deleted");
  assert.equal(statusTone(deleted), "accept");
  assert.equal(needsAttention(deleted), false);
  assert.equal(jobOutcome(deleted, deleted.summary), deleted.summary);
  const unverified = { ...deleted, outcome: "unverified" as const };
  assert.equal(statusLabel(unverified), "Unverified");
  assert.equal(statusTone(unverified), "caution");
  assert.equal(needsAttention(unverified), true);
});

test("legacy successful discard reports command completion without promoting its AWS outcome", () => {
  const legacy = job({ kind: "deploy-discard", status: "succeeded", execution: "finished", exitCode: 0, outcome: "unverified",
    summary: "Plan discarded.", recovery: "Refresh AWS observations to confirm remaining change sets and resources." });
  assert.equal(completedLegacyDiscard(legacy), true);
  assert.equal(statusLabel(legacy), "Done");
  assert.equal(jobOutcome(legacy, legacy.summary), "Plan discarded.");
  assert.equal(statusTone(legacy), "accept");
  assert.equal(needsAttention(legacy), false);
  assert.equal(legacy.outcome, "unverified", "presentation never rewrites domain evidence");
  assert.match(legacy.recovery!, /Refresh AWS/);
  for (const patch of [
    { kind: "deploy-apply" as const }, { status: "failed" as const }, { status: "running" as const }, { status: "cancelled" as const },
    { status: "interrupted" as const }, { execution: "lost" as const }, { execution: undefined }, { exitCode: 1 }, { exitCode: undefined },
    { outcome: "uncertain" as const }, { params: { discardCloud: true } }, { params: { discardCloud: false } },
  ]) assert.equal(completedLegacyDiscard({ ...legacy, ...patch }), false, JSON.stringify(patch));
  assert.equal(statusTone({ ...legacy, params: { discardCloud: true } }), "caution");
  assert.equal(jobOutcome({ ...legacy, params: { discardCloud: true } }, legacy.summary), "Unverified");
  assert.equal(needsAttention({ ...legacy, params: { discardCloud: true } }), true);
});

test("durations count whole minutes at every scale", () => {
  assert.equal(formatDuration(900), "<1m");
  assert.equal(formatDuration(59_999), "<1m");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(72_000), "1m");
  assert.equal(formatDuration(59 * 60_000 + 59_000), "59m");
  assert.equal(formatDuration(3_600_000 * 2 + 14 * 60_000), "2h 14m");
  assert.equal(formatDuration(3_600_000 * 75), "3d 3h");
});

test("Ask Agent carries the failure's context in the composer's limit, centred on the first error", () => {
  const failed = job({ title: "Deploy app", status: "failed", exitCode: 1, steps: [{ label: "Apply", status: "failed" }] });
  const lines = Array.from({ length: 3000 }, (_, index) => ({ seq: index + 1, at: NOW.toISOString(), stream: "out" as const, text: `line ${index + 1} ${"x".repeat(60)}` }));
  lines[1500] = { ...lines[1500]!, stream: "err" as never, text: "AccessDenied: not authorized" };
  const prompt = askAgentPrompt(failed, lines, lines[1500]);
  assert.ok(prompt.length <= 3600);
  assert.match(prompt, /Deploy app/);
  assert.match(prompt, /Failed at Apply/);
  assert.match(prompt, /Exit code: 1/);
  assert.match(prompt, /AccessDenied: not authorized/);
  assert.match(prompt, /line 1500 /, "the lines leading to it give the cause");
  assert.doesNotMatch(prompt, /line 3 /, "an unrelated beginning does not spend the budget");
});

test("Ask Agent uses the recovery note when no log line explains the state", () => {
  const prompt = askAgentPrompt(job({ title: "Deploy app", status: "interrupted", outcome: "uncertain", recovery: "Inspect AWS before planning again." }), [], undefined);
  assert.match(prompt, /Inspect AWS before planning again/);
});
