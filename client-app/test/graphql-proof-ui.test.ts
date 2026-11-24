import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h } from "react";
import { setupDom } from "./support/ui-harness";
import type { ContractReviewDecisions } from "../src/views/graphql/GraphQLChainReview";
import { proofReceiptFixture, proofViewFixture } from "./support/contract-proof";
import { graphqlChainFixture, withChainLink } from "./support/graphql-chain";
import { isGraphQLChainResponse, isLegacyGraphQLChainResponse } from "aws-studio/contract-chain/graphql-chain-response";
import { isContractProofReceipt } from "aws-studio/contract-chain/contract-proof-response";
import type { ChainLink } from "aws-studio/contract-chain/graphql-chain";

const require = createRequire(import.meta.url);
let harness: ReturnType<typeof setupDom>, ui: typeof import("@testing-library/react");
let components: typeof import("../src/views/graphql/GraphQLChainReview");
let lineage: typeof import("../src/views/graphql/GraphQLProofLineage");
before(async () => {
  harness = setupDom(); ui = require("@testing-library/react");
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  components = await import("../src/views/graphql/GraphQLChainReview");
  lineage = await import("../src/views/graphql/GraphQLProofLineage");
});
afterEach(() => ui.cleanup());
after(() => harness.cleanup());

const decisionProps = () => ({ scope: { kind: "api" as const }, expectedRevision: "current", currentRevision: "current", pending: "idle" as const, onBack() {}, onPrepare(_decisions: ContractReviewDecisions) {} });
function fill(kind: "api" | "client", statement = "Keep the new database field private.", evidence = "Explicit developer instruction; existing Project behavior reviewed.") {
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: kind === "api" ? "Accepted API behavior" : "Accepted client behavior" }), { target: { value: statement } });
  const group = ui.screen.getByRole("group", { name: kind === "api" ? "Repository and API" : "Client operations" });
  ui.fireEvent.change(ui.within(group).getByRole("textbox", { name: "Source or user evidence" }), { target: { value: evidence } });
}

test("API review requires deliberate behavior and evidence before preparing any record change", () => {
  const prepared: ContractReviewDecisions[] = [];
  ui.render(h(components.GraphQLChainDecisionReview, { ...decisionProps(), onPrepare: decisions => prepared.push(decisions) }));
  const action = ui.screen.getByRole("button", { name: "Review evidence" }) as HTMLButtonElement;
  assert.equal(action.disabled, true); assert.deepEqual(prepared, []);
  fill("api"); assert.equal(action.disabled, false);
  assert.deepEqual(prepared, [], "typing is not acceptance or review preparation");
  ui.fireEvent.click(action);
  assert.deepEqual(prepared, [{ api: { statement: "Keep the new database field private.", evidence: "Explicit developer instruction; existing Project behavior reviewed." } }]);
  assert.ok(ui.screen.getByText(/unsigned review declarations/));
  assert.ok(ui.screen.getByText(/Candidate decisions are not accepted automatically/));
});

test("baseline preparation requires API and client decisions without inventing defaults", () => {
  const prepared: ContractReviewDecisions[] = [];
  ui.render(h(components.GraphQLChainDecisionReview, { ...decisionProps(), scope: { kind: "baseline" }, onPrepare: decisions => prepared.push(decisions) }));
  const action = ui.screen.getByRole("button", { name: "Review evidence" }) as HTMLButtonElement;
  assert.equal(ui.screen.getByRole("textbox", { name: "Accepted API behavior" }).textContent, "");
  fill("api"); assert.equal(action.disabled, true);
  fill("client", "Preserve selected fields and invalidate only Project keys.");
  assert.equal(action.disabled, false); ui.fireEvent.click(action);
  assert.ok(prepared[0]?.api); assert.ok(prepared[0]?.client);
});

test("whitespace and unavailable or changed source cannot prepare a decision review", () => {
  let prepared = 0;
  const props = { ...decisionProps(), scope: { kind: "client" as const }, onPrepare: () => prepared++ };
  const view = ui.render(h(components.GraphQLChainDecisionReview, props));
  fill("client", "   ");
  assert.equal((ui.screen.getByRole("button", { name: "Review evidence" }) as HTMLButtonElement).disabled, true);
  fill("client");
  view.rerender(h(components.GraphQLChainDecisionReview, { ...props, currentRevision: undefined }));
  assert.equal((ui.screen.getByRole("button", { name: "Review evidence" }) as HTMLButtonElement).disabled, true);
  assert.ok(ui.screen.getByRole("alert"));
  assert.equal((ui.screen.getByRole("textbox", { name: "Accepted client behavior" }) as HTMLTextAreaElement).value, "Keep the new database field private.");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review evidence" }));
  assert.equal(prepared, 0);
});

test("preparation errors preserve decisions and focus an actionable error; pending checks disable editing", async () => {
  const props = decisionProps();
  const view = ui.render(h(components.GraphQLChainDecisionReview, props));
  fill("api");
  view.rerender(h(components.GraphQLChainDecisionReview, { ...props, problem: "Current source changed. Check again." }));
  const alert = ui.screen.getByRole("alert"); await ui.waitFor(() => assert.equal(document.activeElement, alert));
  assert.equal((ui.screen.getByRole("textbox", { name: "Accepted API behavior" }) as HTMLTextAreaElement).value, "Keep the new database field private.");
  view.rerender(h(components.GraphQLChainDecisionReview, { ...props, pending: "checking" }));
  assert.equal((ui.screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled, true);
  assert.equal((ui.screen.getByRole("group", { name: "Repository and API" }) as HTMLFieldSetElement).disabled, true);
});

test("lineage details expose bounded source, predecessor, policy, outcomes and unsigned review declarations", async () => {
  const proof = proofViewFixture();
  ui.render(h(lineage.GraphQLProofLineage, { proof, stages: ["api"] }));
  const disclosure = ui.screen.getByText("Proof lineage").closest("details")!;
  assert.equal(disclosure.open, false, "advanced evidence stays collapsed by default");
  ui.fireEvent.click(ui.screen.getByText("Proof lineage"));
  const stage = await ui.screen.findByRole("region", { name: "Repository and API proof", hidden: true });
  assert.ok(ui.within(stage).getByText("Verified by current checks"));
  assert.ok(ui.within(stage).getByText("Current receipt binding matches"));
  assert.ok(ui.within(stage).getByText("API review declaration"));
  assert.ok(ui.within(stage).getByText("Preserve the approved public API and ownership rules."));
  assert.ok(ui.within(stage).getByText(proof.policy.id));
  assert.ok(ui.within(stage).getByText("Installed portable dependency source"));
  assert.ok(ui.within(stage).getByText(/content identity is not a signature/));
  assert.ok(ui.screen.getByText("No CI observation loaded"));
});

test("changed upstream receipts retain historical evidence without making byte-identical output current", async () => {
  const previous = proofViewFixture(), codegen = previous.stages.find(stage => stage.stage === "codegen")!;
  const proof = { ...previous, stages: previous.stages.map(stage => stage.stage === "codegen" ? { ...stage, status: "blocked" as const,
    current: { ...codegen.current!, id: "9".repeat(64), predecessors: { api: "8".repeat(64) } },
    predecessors: [{ stage: "api" as const, recorded: codegen.recorded!.predecessors.api!, current: "8".repeat(64), matches: false }], action: "Reconcile the changed API predecessor before renewing generated proof." } : stage) };
  ui.render(h(lineage.GraphQLProofLineage, { proof, stages: ["codegen"] }));
  ui.fireEvent.click(ui.screen.getByText("Proof lineage"));
  await ui.screen.findByRole("region", { name: "Generated GraphQL proof", hidden: true });
  assert.ok(ui.screen.getByText("Waiting for predecessor proof"));
  assert.ok(ui.screen.getByText("Previous binding changed or was not recorded."));
  assert.ok(ui.screen.getByText(/recorded receipt differs/));
  assert.ok(ui.screen.getByText(/Recorded historical receipt/));
  assert.equal(ui.screen.queryByText("Verified by current checks"), null);
});

test("restored evidence and claimed CI origins never display current verification", async () => {
  const original = proofViewFixture();
  const proof = { ...original, ci: { status: "matching" as const, message: "Imported CI report has matching content identities." } };
  ui.render(h(lineage.GraphQLProofLineage, { proof, stages: ["client"], current: false }));
  ui.fireEvent.click(ui.screen.getByText("Proof lineage"));
  await ui.screen.findByRole("region", { name: "Client operations proof", hidden: true });
  assert.ok(ui.screen.getByText("Historical evidence"));
  assert.ok(ui.screen.getByText("Historical CI comparison"));
  assert.equal(ui.screen.queryByText("Verified by current checks"), null);
  assert.equal(ui.screen.queryByText("Recorded CI evidence matches"), null);
  assert.ok(ui.screen.getByText(/report labelled CI is not authenticated/));
});

test("candidate receipt details remain explicitly candidate scoped", () => {
  const receipt = proofReceiptFixture("api", "candidate");
  ui.render(h(lineage.GraphQLReceiptDetails, { receipt }));
  assert.ok(ui.screen.getByText("Private candidate · schema 1"));
  assert.equal(ui.screen.queryByText("Saved source · schema 1"), null);
  assert.ok(ui.screen.getByText("Decision binding"));
  assert.ok(ui.screen.getByText(/Stored outcomes and review declarations are historical provenance/));
});

test("browser boundaries reject old, missing, corrupt, candidate and insufficient saved-source proof", () => {
  const chain = graphqlChainFixture();
  assert.equal(isGraphQLChainResponse(chain), true);
  assert.equal(isLegacyGraphQLChainResponse({ ...chain, version: 2 }), true);
  assert.equal(isGraphQLChainResponse({ ...chain, version: 2 }), false);
  assert.equal(isGraphQLChainResponse({ ...chain, proof: undefined }), false);
  assert.equal(isGraphQLChainResponse({ ...chain, links: chain.links.map((link, index) => index === 0 ? { ...link, confidence: { status: "stale", blockedBy: [], diagnostics: [] } } : link) }), false);
  assert.equal(isGraphQLChainResponse({ ...chain, verification: { ...chain.verification, client: { status: "unavailable", diagnostics: [] } } }), false);
  for (const replacement of [null, { ...chain.proof.stages[1]!.current!, scope: "candidate" }, { ...chain.proof.stages[1]!.current!, version: 0 }, { ...chain.proof.stages[1]!.current!, checks: [] }, { ...chain.proof.stages[1]!.current!, checks: [{ ...chain.proof.stages[1]!.current!.checks[0]!, outcome: "unavailable" }] }]) {
    assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, current: replacement } : stage) } }), false);
  }
  const changed = { ...chain.proof.stages[1]!.current!, id: "9".repeat(64) };
  assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, current: changed } : stage) } }), false);
  assert.equal(isContractProofReceipt(proofReceiptFixture("client", "candidate")), true);
  const apiReceipt = chain.proof.stages[1]!.current!;
  const { dependencyDigest: _oldIdentity, ...legacyToolchain } = apiReceipt.toolchain;
  assert.equal(isContractProofReceipt({ ...apiReceipt, toolchain: legacyToolchain }), false);
  const toolMismatch = { ...apiReceipt, toolchain: { ...apiReceipt.toolchain, dependencyDigest: "0".repeat(64) } };
  assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, recorded: toolMismatch } : stage) } }), false);
  assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, current: toolMismatch, recorded: toolMismatch } : stage) } }), false);
  for (const field of ["review", "policy"] as const) {
    const altered = { ...chain.proof.stages[1]!.current!, [field]: field === "review" ? null : { id: "obsolete-policy", digest: "a".repeat(64) } };
    assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, current: altered, recorded: altered } : stage) } }), false);
  }
});

test("fresh mechanical proof may precede recording while a verified complete chain requires durable lineage", () => {
  const chain = graphqlChainFixture(), client = chain.links[2] as Extract<ChainLink, { readonly id: "generated-client" }>;
  const pending = withChainLink(chain, { ...client, state: { status: "no-review" } });
  const proof = { ...pending.proof, stages: pending.proof.stages.map(stage => stage.stage === "codegen" ? { ...stage, recorded: null } : stage) };
  assert.equal(isGraphQLChainResponse({ ...pending, proof }), true);
  assert.equal(isGraphQLChainResponse({ ...chain, proof }), false);
  const api = chain.links[0] as Extract<ChainLink, { readonly id: "prisma-pothos" }>;
  const unreviewed = withChainLink(chain, { ...api, state: { status: "no-review" } });
  const freshDatabase = { ...unreviewed.proof, stages: unreviewed.proof.stages.map(stage => stage.stage === "database" ? { ...stage, recorded: null } : stage) };
  assert.equal(isGraphQLChainResponse({ ...unreviewed, proof: freshDatabase }), true);
  assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "database" ? { ...stage, recorded: null } : stage) } }), false);
  assert.equal(isGraphQLChainResponse({ ...chain, proof: { ...chain.proof, stages: [...chain.proof.stages].reverse() } }), true);
});
