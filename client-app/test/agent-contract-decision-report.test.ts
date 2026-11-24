import assert from "./support/assert";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearContractDecisionReport, contractDecisionReportPath, readContractDecisionReport } from "../server/agent-runtime/contract-decision-report";
import { buildContractCodingContext } from "../shared/contract-propagation";
import { graphqlChainFixture } from "./support/graphql-chain";

test("decision reports accept only bounded known blockers or a resolved observation", t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-decisions-")), file = contractDecisionReportPath(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const decisions = buildContractCodingContext(graphqlChainFixture(), "api").decisions, id = decisions[0]!.id;
  writeFileSync(file, '{"status":"resolved"}');
  assert.deepEqual(readContractDecisionReport(file, decisions), { status: "resolved" });
  const blocker = { status: "needs-decision", decisions: [{ id, reason: "Which existing public behavior should be preserved?" }] };
  writeFileSync(file, JSON.stringify(blocker));
  assert.deepEqual(readContractDecisionReport(file, decisions), blocker);
  for (const invalid of ["not json", '{"status":"resolved","extra":true}', JSON.stringify({ status: "needs-decision", decisions: [] }), JSON.stringify({ status: "needs-decision", decisions: [{ id: "foreign", reason: "Unknown decision" }] }), JSON.stringify({ ...blocker, decisions: [blocker.decisions[0], blocker.decisions[0]] }), JSON.stringify({ ...blocker, decisions: [{ id, reason: "x".repeat(2001) }] }), "x".repeat(32769)]) {
    writeFileSync(file, invalid);
    assert.throws(() => readContractDecisionReport(file, decisions), /valid contract decision report/);
  }
  clearContractDecisionReport(file);
  assert.throws(() => readContractDecisionReport(file, decisions), /Resume/);
});

test("decision reports reject linked files and linked scratch parents", t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-decision-links-")), scratch = path.join(directory, "scratch"), elsewhere = path.join(directory, "elsewhere");
  mkdirSync(scratch); mkdirSync(elsewhere);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = contractDecisionReportPath(scratch), target = contractDecisionReportPath(elsewhere), decisions = buildContractCodingContext(graphqlChainFixture(), "api").decisions;
  writeFileSync(target, '{"status":"resolved"}');
  linkSync(target, file);
  assert.throws(() => readContractDecisionReport(file, decisions), /valid contract decision report/);
  clearContractDecisionReport(file);
  symlinkSync(target, file);
  assert.throws(() => readContractDecisionReport(file, decisions), /valid contract decision report/);
  clearContractDecisionReport(file);
  const linked = path.join(directory, "linked-scratch"); symlinkSync(elsewhere, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readContractDecisionReport(contractDecisionReportPath(linked), decisions), /valid contract decision report/);
  assert.throws(() => clearContractDecisionReport(contractDecisionReportPath(linked)), /previous contract decision report/);
  assert.deepEqual(readContractDecisionReport(target, decisions), { status: "resolved" }, "clearing a linked parent must preserve the external target");
});
