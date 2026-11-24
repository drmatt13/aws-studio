import assert from "./support/assert";
import { test } from "node:test";
import { buildContractCodingContext, contractDecisions, contractLinkForStage, contractStageForLink, nextContractStage, readContractCodingContext, readContractDecisions } from "../shared/contract-propagation";
import { graphqlChainFixture, withChainLink } from "./support/graphql-chain";

test("earliest stage uses chain confidence and preserves fully verified predecessors", () => {
  const chain = graphqlChainFixture();
  assert.equal(nextContractStage(chain), null);
  for (const stage of ["api", "codegen", "client"] as const) {
    const link = chain.links.find(link => link.id === contractLinkForStage(stage))!;
    const changed = withChainLink(chain, { ...link, confidence: { status: "stale", blockedBy: [], diagnostics: [] } });
    assert.equal(nextContractStage(changed), stage);
    assert.equal(contractStageForLink(link.id), stage);
  }
});

test("locally current artifacts cannot skip stale or unavailable API evidence", () => {
  const chain = graphqlChainFixture(), api = chain.links[0]!;
  for (const status of ["blocked", "failed", "unavailable"] as const) assert.equal(nextContractStage(withChainLink(chain, { ...api, confidence: { status, blockedBy: [], diagnostics: [] } })), "api");
  assert.equal(nextContractStage({ ...chain, inspection: { status: "stale" } }), "api");
  assert.equal(buildContractCodingContext({ ...chain, inspection: { status: "checking" } }, "client").predecessors[0]?.status, "unavailable");
});

test("context carries implementation-only diagnostics without fabricating model ownership", () => {
  const chain = graphqlChainFixture(), api = chain.links[0]!;
  const context = buildContractCodingContext(withChainLink(chain, { ...api, confidence: { status: "stale", blockedBy: [], diagnostics: [{ code: "API_IMPLEMENTATION_CHANGED", message: "Resolver changed", file: "schema/project.ts" }] } }), "api");
  assert.deepEqual(context.affected, []);
  assert.equal(context.diagnostics[0]?.code, "API_IMPLEMENTATION_CHANGED");
  assert.equal(context.diagnostics[0]?.message, "Resolver changed");
  assert.deepEqual(readContractCodingContext(context), context);
});

test("private/no-op decisions survive codegen and client transitions with explicit evidence", () => {
  const previous = [{ id: "Project.private:exposure", target: "Project.private", kind: "exposure" as const, status: "established" as const, value: "Private database field; no public API change", evidence: "Developer request; schema/project.ts omits this field" }];
  const codegen = buildContractCodingContext(graphqlChainFixture(), "codegen", previous);
  assert.deepEqual(codegen.decisions, previous);
  const client = buildContractCodingContext(graphqlChainFixture(), "client", codegen.decisions);
  assert.deepEqual(client.decisions[0], previous[0]);
  assert.equal(client.decisions.filter(decision => decision.status === "unresolved").length, 2);
  assert.deepEqual(contractDecisions("codegen", [], previous), previous);
  assert.deepEqual(readContractDecisions(previous), previous);
});

test("fixed policies refuse caller commands, paths, validators and foreign scopes", () => {
  const context = buildContractCodingContext(graphqlChainFixture(), "api");
  for (const override of [{ sourceRoots: ["/"] }, { validators: [] }, { artifacts: [".env"] }, { reviewScopes: [{ kind: "client" }] }, { commands: ["touch /tmp/escape"] }]) assert.throws(() => readContractCodingContext({ ...context, ...override }));
  assert.throws(() => readContractCodingContext({ ...context, predecessors: [{ id: "typed-documents", status: "verified", digest: null }] }));
  assert.throws(() => readContractCodingContext({ ...context, inputs: [] }));
  assert.throws(() => readContractCodingContext({ ...context, inputs: context.inputs.map(input => ({ ...input, digest: "not-a-content-digest" })) }));
  assert.throws(() => readContractCodingContext({ ...context, decisions: [] }));
  assert.throws(() => readContractCodingContext({ ...context, reviewScopes: [] }));
  assert.throws(() => readContractCodingContext({ ...buildContractCodingContext(graphqlChainFixture(), "codegen"), reviewScopes: [{ kind: "none" }] }));
  assert.throws(() => readContractDecisions([{ id: "same", target: "Project", kind: "exposure", status: "established", value: "expose" }]));
  assert.throws(() => readContractDecisions([...context.decisions, context.decisions[0]]));
});

test("unreviewed canonical model shapes appear in stage context without fabricating an accepted baseline", () => {
  const chain = graphqlChainFixture(), api = chain.links[0]!;
  if (api.id !== "prisma-pothos") throw new Error("Missing API fixture");
  const addition = { surface: "prisma" as const, subject: "PrivateEntry", path: "PrivateEntry", change: "added" as const, before: null, after: '{"fields":{"id":{"type":"Uuid"},"privateNote":{"type":"String"}}}' };
  const context = buildContractCodingContext(withChainLink(chain, { ...api, state: { status: "no-review" }, models: { ...api.models, PrivateEntry: { status: "no-review", diffs: [addition] } }, confidence: { status: "stale", blockedBy: [], diagnostics: [] } }), "api");
  assert.deepEqual(context.affected, [addition]);
  assert.ok(context.decisions.some(decision => decision.target === "PrivateEntry" && decision.kind === "exposure" && decision.status === "unresolved"));
});
