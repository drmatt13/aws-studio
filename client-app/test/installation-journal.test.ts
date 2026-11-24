import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requireRestrictedSourceEvaluation, withSourceWriteSync } from "aws-studio/source/source-gate";
import { activateInstallation, restoreInstallation, stageInstallation } from "../server/edits/installation-journal";
import { resolveStudioProject, resolveStudioProjectRoot } from "../server/project";
import { recoverInterruptedProjectUpgrades, SourceJournal } from "../server/edits/journal";
import { archiveTrackingChange, prepareProjectDependencies, type ProjectUpgrade } from "../server/project-upgrade";

const archive = "vendor/aws-studio-2.1.0.tgz";
const previousArchive = "vendor/aws-studio-2.0.0.tgz";
const newArchive = Buffer.from([0x1f, 0x8b, 0, 0xff, 0x3e]);
const integrity = `sha512-${createHash("sha512").update(newArchive).digest("base64")}`;
const artifact = "node_modules/native-test/binding.node";
const nested = "packages/demo/node_modules/tool/package.json";
const framework = "framework.config.ts";

function fixture(use: (root: string, candidate: string) => void): void {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-installation-journal-")));
  const root = path.join(directory, "project"), candidate = path.join(directory, "candidate");
  try {
    for (const [checkout, version] of [[root, "before"], [candidate, "after"]] as const) {
      for (const name of [artifact, nested, framework]) {
        const file = path.join(checkout, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, version);
      }
      mkdirSync(path.join(checkout, "vendor"), { recursive: true });
      if (process.platform !== "win32") symlinkSync("../packages/demo", path.join(checkout, "node_modules/demo"));
    }
    writeFileSync(path.join(candidate, archive), newArchive);
    use(root, candidate);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function plan(root: string, candidate: string) {
  const archiveInfo: ProjectUpgrade["archive"] = { file: archive, source: path.join(candidate, archive), alreadyPresent: false, integrity };
  return stageInstallation(root, candidate, { archive: archiveInfo });
}
const contents = (root: string, name: string) => readFileSync(path.join(root, name), "utf8");
const change = (root: string) => ({ file: path.join(root, framework), before: "before", after: "after" });

test("the next vendored release inherits the exact Git exception without unignoring other tarballs", () => fixture((root, candidate) => {
  const ignore = path.join(candidate, ".gitignore");
  const before = `# Local package builds\r\n*.tgz\r\n!/${previousArchive}\r\n# Keep the rest ignored`;
  const after = `${before}\r\n!/${archive}\r\n`;
  writeFileSync(ignore, before);
  assert.deepEqual(archiveTrackingChange(root, candidate, previousArchive, archive), { file: path.join(root, ".gitignore"), before, after });
  assert.equal(contents(candidate, ".gitignore"), before);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: candidate, encoding: "utf8" }).status, 0);
  writeFileSync(ignore, after);
  for (const [name, status] of [[previousArchive, 1], [archive, 1], ["vendor/unrelated.tgz", 0], ["elsewhere/aws-studio-2.1.0.tgz", 0]] as const) {
    const result = spawnSync("git", ["check-ignore", "--quiet", "--", name], { cwd: candidate, encoding: "utf8" });
    assert.equal(result.status, status, result.stderr);
  }
  assert.equal(archiveTrackingChange(root, candidate, previousArchive, archive), undefined);
  writeFileSync(ignore, `*.tgz\n# !${previousArchive}\n`);
  assert.equal(archiveTrackingChange(root, candidate, previousArchive, archive), undefined);
}));

test("reviewed nested dependencies, binary archive and workspace links activate at the final path", () => fixture((root, candidate) => {
  const journal = new SourceJournal(root);
  withSourceWriteSync(root, () => {
    const installation = plan(root, candidate);
    const id = journal.begin("Upgrade framework", [change(root)], undefined, undefined, installation);
    writeFileSync(path.join(root, framework), "after");
    activateInstallation(root, installation);
    assert.equal(contents(root, artifact), "after");
    assert.equal(contents(root, nested), "after");
    if (process.platform !== "win32") assert.equal(realpathSync(path.join(root, "node_modules/demo")), path.join(root, "packages/demo"));
    assert.deepEqual(readFileSync(path.join(root, archive)), newArchive);
    journal.finish(id, "complete");
  });
  assert.deepEqual(journal.pending(), []);
}));

test("a dependency-only review activates workspace packages without adding an archive", () => fixture((root, candidate) => {
  const journal = new SourceJournal(root);
  withSourceWriteSync(root, () => {
    const installation = stageInstallation(root, candidate, {});
    const id = journal.begin("Add workspace dependencies", [change(root)], undefined, undefined, installation);
    writeFileSync(path.join(root, framework), "after");
    activateInstallation(root, installation);
    assert.equal(contents(root, artifact), "after");
    assert.equal(contents(root, nested), "after");
    assert.equal(existsSync(path.join(root, archive)), false);
    journal.finish(id, "complete");
  });
  assert.deepEqual(journal.pending(), []);
}));

test("a failed dependency activation restores an earlier activated tree and the exact binary archive state", () => fixture((root, candidate) => {
  const journal = new SourceJournal(root);
  withSourceWriteSync(root, () => {
    const installation = plan(root, candidate);
    const id = journal.begin("Upgrade framework", [change(root)], undefined, undefined, installation);
    const staged = path.join(root, ".cache/framework-studio/transactions", `installation-${installation.id}`, "new-1");
    writeFileSync(path.join(staged, "unexpected"), "staged content changed");
    assert.throws(() => activateInstallation(root, installation), /packages\/demo\/node_modules changed/);
    assert.equal(contents(root, artifact), "after", "the first dependency root was activated");
    assert.equal(contents(root, nested), "before", "the failing root was preserved");
    assert.equal(restoreInstallation(root, installation), true);
    assert.equal(contents(root, artifact), "before");
    assert.equal(contents(root, nested), "before");
    assert.equal(existsSync(path.join(root, archive)), false);
    assert.equal(contents(staged, "unexpected"), "staged content changed", "the operation did not delete unknown state");
    journal.finish(id, "restored");
  });
  assert.deepEqual(journal.pending(), []);
}));

function interrupt(root: string, candidate: string, activate: boolean): string {
  const worker = path.resolve(__dirname, "../server/edits/installation-journal.ts");
  const journal = path.resolve(__dirname, "../server/edits/journal.ts");
  const upgrade = path.resolve(__dirname, "../server/project-upgrade.ts");
  const ignore = `*.tgz\n!${previousArchive}\n`;
  for (const checkout of [root, candidate]) writeFileSync(path.join(checkout, ".gitignore"), ignore);
  const script = `
    const fs = require("node:fs");
    const { withSourceWriteSync } = require("aws-studio/source/source-gate");
    const { SourceJournal } = require(${JSON.stringify(journal)});
    const { activateInstallation, stageInstallation } = require(${JSON.stringify(worker)});
    const { archiveTrackingChange } = require(${JSON.stringify(upgrade)});
    const [root, candidate] = process.argv.slice(1);
    const journal = new SourceJournal(root);
    withSourceWriteSync(root, () => {
      const installation = stageInstallation(root, candidate, {archive: {file: ${JSON.stringify(archive)}, integrity: ${JSON.stringify(integrity)}, alreadyPresent: false}});
      const file = require("node:path").join(root, ${JSON.stringify(framework)});
      const tracking = archiveTrackingChange(root, candidate, ${JSON.stringify(previousArchive)}, ${JSON.stringify(archive)});
      const id = journal.begin("Interrupted upgrade", [{file, before:"before", after:"after"}, {...tracking, authority:"project-upgrade"}], undefined, undefined, installation);
      fs.writeFileSync(file, "after");
      fs.writeFileSync(tracking.file, tracking.after);
      if (${activate}) activateInstallation(root, installation);
      fs.writeSync(1, id);
      process.exit(73);
    });
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script, root, candidate], { encoding: "utf8" });
  assert.equal(child.status, 73, child.stderr);
  return child.stdout;
}

test("a fresh process recovers a stopped upgrade after journaling source and before dependency activation", () => fixture((root, candidate) => {
  const id = interrupt(root, candidate, false);
  const journal = new SourceJournal(root);
  assert.deepEqual(journal.interruptedInstallations(), [id]);
  assert.equal(resolveStudioProjectRoot({ args: ["--project", root], env: {}, cwd: root }, { recovery: true }), root, "recovery remains available before all project markers are restored");
  writeFileSync(path.join(root, "package.json"), "{}");
  assert.throws(() => resolveStudioProject({ args: ["--project", root], env: {}, cwd: root }), /--recover-upgrade/);
  assert.match(recoverInterruptedProjectUpgrades(root, { status: true }), /Reviewed fingerprint: [a-f0-9]{64}/);
  assert.throws(() => recoverInterruptedProjectUpgrades(root, { id, fingerprint: "0".repeat(64) }), /changed since recovery review/);
  assert.throws(() => withSourceWriteSync(root, () => assert.fail("interrupted upgrade admitted a competing write")), /interrupted|recovery/i);
  assert.deepEqual(journal.restore(id, "RESTORE SOURCE"), []);
  assert.equal(contents(root, artifact), "before");
  assert.equal(contents(root, framework), "before");
  assert.equal(contents(root, ".gitignore"), `*.tgz\n!${previousArchive}\n`);
  assert.equal(existsSync(path.join(root, archive)), false);
}));

test("a stopped post-activation check restores the original package tree or preserves a competing install", () => {
  fixture((root, candidate) => {
    const id = interrupt(root, candidate, true);
    const journal = new SourceJournal(root);
    assert.equal(contents(root, artifact), "after");
    assert.equal(journal.pending()[0]?.files.find(file => file.file === "node_modules")?.state, "written");
    assert.deepEqual(journal.restore(id, "RESTORE SOURCE"), []);
    assert.equal(contents(root, artifact), "before");
    assert.equal(contents(root, nested), "before");
    assert.equal(contents(root, framework), "before");
    assert.equal(existsSync(path.join(root, archive)), false);
  });
  fixture((root, candidate) => {
    const id = interrupt(root, candidate, true);
    const journal = new SourceJournal(root);
    writeFileSync(path.join(root, artifact), "other");
    writeFileSync(path.join(root, framework), "external edit");
    const [pending] = journal.restore(id, "RESTORE SOURCE");
    assert.equal(pending?.files.find(file => file.file === "node_modules")?.state, "conflicted");
    assert.equal(pending?.files.find(file => file.file === framework)?.state, "conflicted");
    assert.equal(contents(root, artifact), "other");
    assert.equal(contents(root, framework), "external edit");
    assert.equal(contents(root, nested), "before");
    assert.throws(() => withSourceWriteSync(root, () => assert.fail("conflicted upgrade admitted a competing write")), /recovery/i);
  });
});

test("restricted projects stop before starting an unsandboxed dependency lifecycle", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-restricted-installation-")));
  try {
    withSourceWriteSync(root, () => requireRestrictedSourceEvaluation(root));
    await assert.rejects(prepareProjectDependencies(root, [], async () => assert.fail("candidate validation ran")), /qualified restricted npm installer/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
