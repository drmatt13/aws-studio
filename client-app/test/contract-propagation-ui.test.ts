import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, useState } from "react";
import type { CodingTask } from "../shared/agent-runtime";
import type { ContractDecision } from "../shared/contract-propagation";
import { codingApprovalProblem } from "../src/coding-presentation";
import { contractTaskFixture } from "./support/contract-propagation";
import { setupDom } from "./support/ui-harness";
import { buildContractCodingContext } from "../shared/contract-propagation";
import { graphqlChainFixture } from "./support/graphql-chain";

const require = createRequire(import.meta.url);
let harness: ReturnType<typeof setupDom>, ui: typeof import("@testing-library/react"), view: typeof import("../src/views/graphql/GraphQLContractWorkflow");
before(async () => { harness = setupDom(); ui = require("@testing-library/react"); view = await import("../src/views/graphql/GraphQLContractWorkflow"); });
afterEach(() => ui.cleanup()); after(() => harness.cleanup());

test("the saved-source next action targets the earliest invalid stage", () => {
  const selected: string[] = [];
  ui.render(h(view.GraphQLContractWorkflow, { stage: "api", checking: false, onStart: stage => selected.push(stage), onOpen: () => {} }));
  assert.ok(ui.screen.getByText("Saved source"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Draft next task" }));
  assert.deepEqual(selected, ["api"]);
  assert.equal(ui.screen.queryByRole("region", { name: "Candidate contract progress" }), null);
});

test("a private candidate retains passed checkpoints but requires explicit decision evidence before continuing", () => {
  const before = contractTaskFixture(), submitted: (readonly ContractDecision[])[] = [];
  const only = before.contract!.decisions.slice(0, 1);
  const task: CodingTask = { ...before, contract: { ...before.contract!, decisions: only, checkpoints: before.contract!.checkpoints.map(checkpoint => ({ ...checkpoint, decisions: only })) } };
  function Candidate() {
    const [decisions, update] = useState<readonly ContractDecision[]>(only);
    return h(view.ContractTaskProgress, { task, decisions, onDecisionsChange: update, onContinue: () => submitted.push(decisions) });
  }
  ui.render(h(Candidate));
  assert.ok(ui.screen.getByText("Private candidate"));
  assert.ok(ui.screen.getByText(/Saved-source approval follows candidate review and independent checks/));
  const next = ui.screen.getByRole("button", { name: "Continue to Generate documents" });
  assert.equal(next.hasAttribute("disabled"), true);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Reviewed behavior" }), { target: { value: "Keep this field private; no public API or client change." } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Source or user evidence" }), { target: { value: "User decision in this review" } });
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "I reviewed this decision" }));
  assert.equal(next.hasAttribute("disabled"), false);
  assert.equal(next.textContent, "Apply decisions to candidate");
  ui.fireEvent.click(next);
  assert.equal(submitted.length, 1); assert.equal(submitted[0]![0]!.status, "established");
  assert.match(submitted[0]![0]!.value!, /private/);
});

test("already validated developer decisions continue without rerunning completed stages", () => {
  const before = contractTaskFixture();
  const decisions = before.contract!.decisions.map(decision => ({ ...decision, status: "established" as const, value: "Keep this field private", evidence: "Explicit developer intent" }));
  const task: CodingTask = { ...before, contract: { ...before.contract!, decisions, checkpoints: before.contract!.checkpoints.map(checkpoint => ({ ...checkpoint, decisions })) } };
  ui.render(h(view.ContractTaskProgress, { task, onContinue: () => {} }));
  assert.equal(ui.screen.getByRole("button", { name: "Continue to Generate documents" }).hasAttribute("disabled"), false);
  assert.equal(ui.screen.queryByRole("button", { name: "Apply decisions to candidate" }), null);
});

for (const status of ["failed", "unavailable", "empty", "wrong-candidate"] as const) test(`${status} checkpoint evidence cannot advance a candidate`, () => {
  const before = contractTaskFixture(), checkpoint = before.contract!.checkpoints[0]!;
  const task: CodingTask = { ...before, contract: { ...before.contract!, decisions: [], checkpoints: [{ ...checkpoint, decisions: [], status: status === "failed" || status === "unavailable" ? status : "passed", checks: status === "empty" ? [] : checkpoint.checks.map(check => ({ ...check, candidateDigest: status === "wrong-candidate" ? "other" : check.candidateDigest })) }] } };
  ui.render(h(view.ContractTaskProgress, { task, onContinue: () => assert.fail("cannot continue") }));
  const next = ui.screen.queryByRole("button", { name: /Continue to Generate documents|Apply decisions to candidate/ });
  assert.ok(!next || next.hasAttribute("disabled"));
  assert.equal(ui.screen.queryByText("Checks passed"), null);
});

for (const kind of ["legacy", "wrong-scope", "wrong-reference", "stale-predecessor", "failed-predecessor", "failed-proof", "empty-proof"] as const) test(`${kind} candidate proof never establishes readiness or application eligibility`, () => {
  const before = contractTaskFixture("client"), contract = before.contract!, proof = contract.proofs!.client!;
  const proofs = kind === "legacy" ? undefined : { ...contract.proofs, ...(kind === "failed-predecessor" ? { api: { ...contract.proofs!.api!, checks: contract.proofs!.api!.checks.map(check => ({ ...check, outcome: "failed" as const })) } } : {}), client: kind === "wrong-scope" ? { ...proof, scope: "saved" as const } : kind === "stale-predecessor" ? { ...proof, predecessors: { ...proof.predecessors, api: "a".repeat(64) } } : kind === "failed-proof" ? { ...proof, checks: proof.checks.map(check => ({ ...check, outcome: "failed" as const })) } : kind === "empty-proof" ? { ...proof, checks: [] } : proof };
  const task: CodingTask = { ...before, contract: { ...contract, status: "ready", proofs, checkpoints: contract.checkpoints.map(checkpoint => ({ ...checkpoint, ...(kind === "wrong-reference" ? { receiptId: "b".repeat(64) } : {}) })) } };
  ui.render(h(view.ContractTaskProgress, { task }));
  assert.ok(ui.screen.getByText("Historical candidate evidence"));
  assert.equal(ui.screen.queryByText("Candidate ready for review"), null);
  assert.equal(ui.screen.queryByText("Checks passed"), null);
  const proposal = { id: "proposal", taskId: task.id, digest: "proposal", baselineDigest: "base", candidateDigest: "candidate", createdAt: "now", changes: [], activation: "none" as const, limitations: [], validation: [{ command: "Independent checks", status: "passed" as const, candidateDigest: "candidate" }] };
  assert.match(codingApprovalProblem(task, proposal)!, /proof/i);
});

test("new established decisions may repair a failed stage but cannot bypass unavailable evidence", () => {
  const before = contractTaskFixture(), checkpoint = before.contract!.checkpoints[0]!;
  const decisions = before.contract!.decisions.map(decision => ({ ...decision, status: "established" as const, value: "Keep private", evidence: "Developer intent" }));
  const task: CodingTask = { ...before, contract: { ...before.contract!, checkpoints: [{ ...checkpoint, status: "failed", checks: checkpoint.checks.map(check => ({ ...check, status: "failed" })) }] } };
  const rendered = ui.render(h(view.ContractTaskProgress, { task, decisions, onContinue: () => {} }));
  assert.equal(ui.screen.getByRole("button", { name: "Apply decisions to candidate" }).hasAttribute("disabled"), false);
  rendered.rerender(h(view.ContractTaskProgress, { task: { ...task, contract: { ...task.contract!, checkpoints: [{ ...checkpoint, status: "unavailable" }] } }, decisions, onContinue: () => {} }));
  assert.equal(ui.screen.getByRole("button", { name: "Apply decisions to candidate" }).hasAttribute("disabled"), true);
});

test("ready and applied candidate observations never claim saved-source verification", () => {
  const before = contractTaskFixture("client");
  const ready: CodingTask = { ...before, contract: { ...before.contract!, status: "ready", stage: "client", decisions: [] } };
  const rendered = ui.render(h(view.ContractTaskProgress, { task: ready }));
  assert.ok(ui.screen.getByText("Candidate ready for review"));
  assert.equal(ui.screen.queryByText("Contract chain verified"), null);
  rendered.rerender(h(view.ContractTaskProgress, { task: { ...ready, status: "completed", sourceOutcome: "unchanged", contract: { ...ready.contract!, status: "applied-awaiting-check" } } }));
  assert.ok(ui.screen.getByText("Applied · verification pending"));
  assert.ok(ui.screen.getByText(/older task has no saved-source approval result/));
  assert.equal(ui.screen.queryByText("Contract chain verified"), null);
});

test("only a ready contract can approve a validated no-op proposal", () => {
  const task = contractTaskFixture();
  const proposal = { id: "proposal", taskId: task.id, digest: "proposal", baselineDigest: "base", candidateDigest: "candidate", createdAt: "now", changes: [], activation: "none" as const, limitations: [], validation: [{ command: "Independent checks", status: "passed" as const, candidateDigest: "candidate" }] };
  assert.match(codingApprovalProblem(task, proposal)!, /Complete the required contract stages/);
  const final = contractTaskFixture("client");
  assert.equal(codingApprovalProblem({ ...final, contract: { ...final.contract!, status: "ready" } }, proposal), undefined);
  assert.match(codingApprovalProblem({ ...task, contract: undefined }, proposal)!, /no source changes/);
});

test("renewed saved-source verification supersedes an applied task's pending observation", () => {
  const before = contractTaskFixture();
  const task: CodingTask = { ...before, status: "completed", contract: { ...before.contract!, status: "applied-awaiting-check" } };
  ui.render(h(view.GraphQLContractWorkflow, { stage: null, task, checking: false, onStart: () => {}, onOpen: () => {} }));
  assert.ok(ui.screen.getByText("Contract chain verified"));
  assert.equal(ui.screen.queryByText("Applied · verification pending"), null);
  assert.ok(ui.screen.getByRole("button", { name: "View applied task" }));
});

for (const status of ["failed", "conflicted", "interrupted", "cancelled", "integrating", "recovery_required", "rejected"] as const) test(`${status} task state makes retained candidate checks historical`, () => {
  const before = contractTaskFixture("client");
  const task: CodingTask = { ...before, status, contract: { ...before.contract!, status: "ready" } };
  ui.render(h(view.ContractTaskProgress, { task, onContinue: () => assert.fail("historical checks cannot continue") }));
  assert.ok(ui.screen.getByText("Historical candidate evidence"));
  assert.ok(ui.screen.getByText("Previous check · passed"));
  assert.equal(ui.screen.queryByText("Candidate ready for review"), null);
  assert.equal(ui.screen.queryByText("Checks passed"), null);
  assert.equal(ui.screen.queryByRole("button", { name: /Continue to|Apply decisions/ }), null);
});

test("working validation and failed task reads cannot display current ready evidence", () => {
  const before = contractTaskFixture("client"), task: CodingTask = { ...before, status: "validating", contract: { ...before.contract!, status: "ready" } };
  const rendered = ui.render(h(view.ContractTaskProgress, { task }));
  assert.ok(ui.screen.getByText("Private candidate · Validating"));
  assert.ok(ui.screen.getByText("Previous check · passed"));
  assert.equal(ui.screen.queryByText("Candidate ready for review"), null);
  rendered.rerender(h(view.ContractTaskProgress, { task: { ...task, status: "awaiting_review" }, current: false }));
  assert.ok(ui.screen.getByText("Historical candidate evidence"));
  assert.ok(ui.screen.getByText(/Retry the task read in Coding/));
  assert.equal(ui.screen.queryByText("Candidate ready for review"), null);
});

for (const status of ["failed", "cancelled"] as const) test(`${status} origin rejection can start from current source without losing task history`, () => {
  const before = contractTaskFixture(), starts: string[] = [], opened: string[] = [];
  const task: CodingTask = { ...before, status, proposalDigest: undefined, contract: { ...before.contract!, checkpoints: [] } };
  const rendered = ui.render(h(view.GraphQLContractWorkflow, { stage: "api", task, checking: false, onStart: stage => starts.push(stage), onOpen: task => opened.push(task.id) }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Draft task from current source" }));
  assert.deepEqual(starts, ["api"]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Open in Coding" }));
  assert.deepEqual(opened, [task.id]);
  rendered.rerender(h(view.GraphQLContractWorkflow, { stage: "api", task, checking: true, onStart: () => assert.fail("stale source cannot start a task"), onOpen: () => {} }));
  assert.equal(ui.screen.getByRole("button", { name: "Draft task from current source" }).hasAttribute("disabled"), true);
});

test("historical saved-source evidence keeps task progress visible without offering a new run", () => {
  const task = contractTaskFixture();
  const rendered = ui.render(h(view.GraphQLContractWorkflow, { stage: "api", task, checking: false, sourceCurrent: false, onStart: () => assert.fail("historical source cannot start a task"), onOpen: () => {} }));
  assert.ok(ui.within(rendered.container).getByRole("region", { name: "Candidate contract progress" }));
  assert.equal(ui.screen.queryByText("Current source needs checking"), null);
  assert.equal(ui.screen.queryByRole("button", { name: "Draft next task" }), null);
});

test("a direct client task distinguishes saved predecessors from candidate checkpoint receipts", () => {
  const before = contractTaskFixture(), context = buildContractCodingContext(graphqlChainFixture(), "client");
  const task: CodingTask = { ...before, status: "running", contract: { ...before.contract!, context, stage: "client", status: "working", checkpoints: [] } };
  const rendered = ui.render(h(view.ContractTaskProgress, { task }));
  assert.equal(ui.screen.getAllByText("Verified saved predecessor").length, 2);
  assert.ok(ui.screen.getByText(/verified at task capture/));
  assert.equal(ui.screen.queryByText("Checks passed"), null);
  assert.equal(ui.screen.queryByText("Inspect checkpoint evidence"), null);
  assert.deepEqual(task.contract!.checkpoints, []);
  rendered.rerender(h(view.ContractTaskProgress, { task: { ...task, status: "conflicted" } }));
  assert.equal(ui.screen.queryByText("Verified saved predecessor"), null);
  assert.equal(ui.screen.getAllByText("Saved predecessor · at capture").length, 2);
});

test("unidentified saved predecessors never become verified candidate evidence", () => {
  const before = contractTaskFixture(), context = buildContractCodingContext(graphqlChainFixture(), "client");
  const task: CodingTask = { ...before, contract: { ...before.contract!, context: { ...context, predecessors: context.predecessors.map(predecessor => ({ ...predecessor, digest: null })) }, stage: "client", checkpoints: [] } };
  ui.render(h(view.ContractTaskProgress, { task }));
  assert.equal(ui.screen.queryByText("Verified saved predecessor"), null);
  assert.equal(ui.screen.queryByText("Checks passed"), null);
});
