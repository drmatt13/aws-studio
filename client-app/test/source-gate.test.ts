import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { publishSourceSnapshot, releaseAbandonedSourceRead, requireRestrictedSourceEvaluation, restrictedSourceEvaluationRequired, sourceCoordinationState, SourceGateError, SourceGateObserver, sourcePublicationEpoch, withSourceWriteSync } from "aws-studio/source/source-gate";
import { SourceJournal } from "../server/edits/journal";
import { listAgentIntegrationRecovery } from "../server/agent-runtime/integration";
import { processIdentity } from "aws-studio/source/identity";
import { applyWindowsSecurityDescriptor, assertWindowsPrivatePath, captureWindowsSecurityDescriptor } from "aws-studio/cli/windows-security";

const cache = path.resolve(__dirname, "../../.cache/framework-studio/source-gate-tests");
mkdirSync(cache, { recursive: true });

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(cache, "case-")));
  return { root, file: path.join(root, ".cache/framework-studio/source-gate/coordination.sqlite"), dispose() {
    if (path.dirname(root) !== realpathSync(cache)) throw new Error("Refusing to remove a fixture outside the test directory.");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

function abandon(root: string, kind: "read" | "write" | "recovery"): void {
  const module = pathToFileURL(path.resolve(__dirname, "../../packages/aws-studio/scripts/source/source-gate.ts")).href;
  const reserve = { read: "withSourceRead", write: "withSourceWrite", recovery: "withSourceRecovery" }[kind];
  const script = `import { ${reserve} } from ${JSON.stringify(module)}; await ${reserve}(${JSON.stringify(root)}, async () => { process.exit(0); });`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
}

function renamed(f: ReturnType<typeof fixture>, action: (root: string, file: string) => void): void {
  const root = `${f.root}-renamed`;
  renameSync(f.root, root);
  try { action(realpathSync(root), path.join(root, ".cache/framework-studio/source-gate/coordination.sqlite")); }
  finally { renameSync(root, f.root); }
}

function legacyCoordination(file: string): void {
  const db = new DatabaseSync(file);
  try { db.exec("ALTER TABLE coordination DROP COLUMN checkout_identity; DROP TABLE checkout_locations"); }
  finally { db.close(); }
}

for (const legacy of [false, true]) {
  test(`an idle ${legacy ? "legacy" : "current"} checkout survives repeated folder renames without losing history or evaluation policy`, () => {
    const f = fixture();
    try {
      withSourceWriteSync(f.root, () => requireRestrictedSourceEvaluation(f.root));
      const epoch = sourcePublicationEpoch(f.root), id = randomUUID();
      const transaction = JSON.stringify({ version: 1, id, root: f.root, status: "complete", changes: [], label: "Completed edit", createdAt: new Date().toISOString() });
      const integration = JSON.stringify({ version: 1, id, root: f.root, status: "applied", changes: [], createdDirectories: [], proposalDigest: "a".repeat(64), baselineDigest: "b".repeat(64), candidateDigest: "c".repeat(64) });
      for (const [directory, contents] of [["transactions", transaction], ["agent-integrations", integration]]) {
        mkdirSync(path.join(f.root, ".cache/framework-studio", directory!));
        writeFileSync(path.join(f.root, ".cache/framework-studio", directory!, `${id}.json`), contents!);
      }
      if (legacy) legacyCoordination(f.file);
      const check = (root: string) => {
        const observer = new SourceGateObserver(root);
        try { assert.deepEqual(observer.state(), { status: "ready", epoch }); }
        finally { observer.close(); }
        assert.equal(sourcePublicationEpoch(root), epoch);
        assert.equal(restrictedSourceEvaluationRequired(root), true);
        assert.deepEqual(new SourceJournal(root).pending(), []);
        assert.deepEqual(listAgentIntegrationRecovery(root), []);
        assert.equal(readFileSync(path.join(root, ".cache/framework-studio/transactions", `${id}.json`), "utf8"), transaction);
        assert.equal(readFileSync(path.join(root, ".cache/framework-studio/agent-integrations", `${id}.json`), "utf8"), integration);
        assert.equal(publishSourceSnapshot(root, epoch, () => "published after rename"), "published after rename");
      };
      renamed(f, root => check(root));
      // Moving back is a second rename and must retain the first location's history.
      check(f.root);
      withSourceWriteSync(f.root, () => undefined);
    } finally { f.dispose(); }
  });
}

for (const kind of ["read", "write", "recovery"] as const) {
  test(`renaming preserves an abandoned ${kind} lease for inspection`, () => {
    const f = fixture();
    try {
      abandon(f.root, kind);
      renamed(f, (root, file) => {
        assert.throws(() => sourcePublicationEpoch(root), /renamed checkout.*idle/);
        const db = new DatabaseSync(file);
        try {
          const row = db.prepare("SELECT root,lease FROM coordination WHERE singleton=1").get()!;
          assert.equal(row.root, f.root);
          assert.equal(JSON.parse(String(row.lease)).kind, kind);
        } finally { db.close(); }
      });
    } finally { f.dispose(); }
  });
}

for (const pending of ["import-marker", "transaction", "agent-integration", "unreadable-transaction", "legacy-lock"] as const) {
  test(`renaming cannot bypass pending ${pending} recovery`, () => {
    const f = fixture();
    try {
      publishSourceSnapshot(f.root, "initial", () => undefined);
      const id = randomUUID();
      if (pending === "import-marker") {
        const db = new DatabaseSync(f.file);
        try { db.prepare("UPDATE coordination SET recovery=? WHERE singleton=1").run(id); }
        finally { db.close(); }
      } else {
        const directory = path.join(f.root, ".cache/framework-studio", pending === "agent-integration" ? "agent-integrations" : "transactions");
        mkdirSync(directory);
        writeFileSync(path.join(directory, pending === "legacy-lock" ? "source.lock" : `${id}.json`), pending === "unreadable-transaction" ? "unreadable" : JSON.stringify({ status: "applying" }));
      }
      renamed(f, (root, file) => {
        assert.equal(sourceCoordinationState(root).status, "unavailable");
        assert.throws(() => sourcePublicationEpoch(root), /renamed checkout.*idle/);
        const db = new DatabaseSync(file);
        try { assert.equal(db.prepare("SELECT root FROM coordination WHERE singleton=1").get()!.root, f.root); }
        finally { db.close(); }
      });
    } finally { f.dispose(); }
  });
}

test("a copied coordination database cannot impersonate a rename even after the original path disappears", () => {
  const first = fixture(), second = fixture();
  try {
    publishSourceSnapshot(first.root, "initial", () => undefined);
    mkdirSync(path.dirname(second.file), { recursive: true });
    copyFileSync(first.file, second.file);
    renamed(first, () => {
      assert.throws(() => sourcePublicationEpoch(second.root), /another checkout/);
    });
  } finally { first.dispose(); second.dispose(); }
});

test("a stopped reader releases without changing the source epoch and observers see the release", () => {
  const f = fixture(), observer = new SourceGateObserver(f.root);
  try {
    abandon(f.root, "read");
    const before = observer.state();
    assert.equal(before.status, "recovery_required");
    assert.equal(before.mode, "read");
    assert.equal(releaseAbandonedSourceRead(f.root), true);
    assert.deepEqual(observer.state(), { status: "ready", epoch: before.epoch });
    assert.equal(sourcePublicationEpoch(f.root), before.epoch);
    assert.equal(releaseAbandonedSourceRead(f.root), false);
    withSourceWriteSync(f.root, () => undefined);
  } finally { observer.close(); f.dispose(); }
});

test("releasing a reader on a fresh checkout creates no coordination storage", () => {
  const f = fixture();
  try {
    assert.equal(releaseAbandonedSourceRead(f.root), false);
    assert.equal(existsSync(path.dirname(f.file)), false);
  } finally { f.dispose(); }
});

test("live and unverifiable readers retain their reservations", () => {
  const f = fixture();
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    const db = new DatabaseSync(f.file), id = randomUUID();
    try {
      for (const started of [processIdentity(id).started, ""]) {
        const lease = JSON.stringify({ id, kind: "read", identity: { ...processIdentity(id), started } });
        db.prepare("UPDATE coordination SET lease=? WHERE singleton=1").run(lease);
        assert.equal(releaseAbandonedSourceRead(f.root), false);
        assert.equal(db.prepare("SELECT lease FROM coordination").get()!.lease, lease);
      }
    } finally { db.close(); }
  } finally { f.dispose(); }
});

for (const kind of ["write", "recovery"] as const) {
  test(`a stopped ${kind} owner still requires explicit recovery`, () => {
    const f = fixture();
    try {
      abandon(f.root, kind);
      const before = sourceCoordinationState(f.root);
      assert.equal(releaseAbandonedSourceRead(f.root), false);
      assert.deepEqual(sourceCoordinationState(f.root), before);
      assert.throws(() => sourcePublicationEpoch(f.root), /active or interrupted/);
    } finally { f.dispose(); }
  });
}

for (const pending of ["import-marker", "transaction", "agent-integration", "unreadable-transaction"] as const) {
  test(`an abandoned reader preserves pending ${pending} recovery`, () => {
    const f = fixture();
    try {
      abandon(f.root, "read");
      const id = randomUUID();
      if (pending === "import-marker") {
        const db = new DatabaseSync(f.file);
        try { db.prepare("UPDATE coordination SET recovery=? WHERE singleton=1").run(id); }
        finally { db.close(); }
      } else {
        const directory = path.join(f.root, ".cache/framework-studio", pending === "agent-integration" ? "agent-integrations" : "transactions");
        mkdirSync(directory);
        writeFileSync(path.join(directory, `${id}.json`), pending === "unreadable-transaction" ? "unreadable" : JSON.stringify({ status: "applying" }));
      }
      const before = sourceCoordinationState(f.root);
      assert.equal(releaseAbandonedSourceRead(f.root), false);
      assert.deepEqual(sourceCoordinationState(f.root), before);
      assert.throws(() => sourcePublicationEpoch(f.root), /active or interrupted/);
    } finally { f.dispose(); }
  });
}

test("a fresh checkout publishes and reopens its coordination database on this platform", () => {
  const f = fixture();
  try {
    assert.equal(sourcePublicationEpoch(f.root), "initial");
    assert.equal(publishSourceSnapshot(f.root, "initial", () => "published"), "published");
    if (process.platform === "win32") {
      assertWindowsPrivatePath(path.dirname(f.file));
      assertWindowsPrivatePath(f.file);
    }
    assert.equal(sourceCoordinationState(f.root).status, "ready");
    assert.equal(restrictedSourceEvaluationRequired(f.root), false);
    withSourceWriteSync(f.root, () => {
      const held = sourceCoordinationState(f.root);
      assert.equal(held.status, "busy");
      assert.equal(held.mode, "write");
      assert.equal(held.ownerPid, process.pid);
    });
    const epoch = sourcePublicationEpoch(f.root);
    assert.notEqual(epoch, "initial");
    assert.equal(publishSourceSnapshot(f.root, epoch, () => "republished"), "republished");
    assert.equal(sourceCoordinationState(f.root).status, "ready");
    assert.throws(() => publishSourceSnapshot(f.root, "initial", () => assert.fail("stale publication must not run")), /incomplete snapshot was discarded/);
  } finally { f.dispose(); }
});

test("only an identified live owner is classified as a temporary source hold", () => {
  const f = fixture();
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    const id = randomUUID(), lease = { id, kind: "write", identity: processIdentity(id) };
    const writeLease = (value: unknown) => { const db = new DatabaseSync(f.file); try { db.prepare("UPDATE coordination SET lease=? WHERE singleton=1").run(JSON.stringify(value)); } finally { db.close(); } };
    writeLease(lease);
    assert.throws(() => sourcePublicationEpoch(f.root), error => error instanceof SourceGateError && error.activeOwner);
    writeLease({ ...lease, identity: { ...lease.identity, started: "" } });
    assert.throws(() => sourcePublicationEpoch(f.root), error => error instanceof SourceGateError && !error.activeOwner, "an existing PID without a birth identity remains fail closed");
  } finally { f.dispose(); }
});

test("coordination storage still rejects hard-linked files", () => {
  const f = fixture();
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    linkSync(f.file, path.join(f.root, "linked.sqlite"));
    assert.throws(() => sourcePublicationEpoch(f.root), /private regular file/);
    assert.equal(sourceCoordinationState(f.root).status, "unavailable");
  } finally { f.dispose(); }
});

test("coordination storage rejects a directory in place of the database", () => {
  const f = fixture();
  try {
    mkdirSync(f.file, { recursive: true });
    assert.throws(() => sourcePublicationEpoch(f.root), /private regular file/);
  } finally { f.dispose(); }
});

test("coordination storage retains POSIX private-file permission checks", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    chmodSync(f.file, 0o644);
    assert.throws(() => sourcePublicationEpoch(f.root), /private regular file/);
    chmodSync(f.file, 0o600);
    assert.equal(sourcePublicationEpoch(f.root), "initial");
  } finally { f.dispose(); }
});

test("coordination storage cannot be reused by another checkout", () => {
  const first = fixture(), second = fixture();
  try {
    publishSourceSnapshot(first.root, "initial", () => undefined);
    mkdirSync(path.dirname(second.file), { recursive: true });
    copyFileSync(first.file, second.file);
    assert.throws(() => sourcePublicationEpoch(second.root), /another checkout/);
  } finally { first.dispose(); second.dispose(); }
});

test("coordination storage rechecks a changed Windows DACL on the same database", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    const descriptor = captureWindowsSecurityDescriptor(f.file);
    applyWindowsSecurityDescriptor(f.file, `${descriptor}(A;;FR;;;WD)`);
    assert.throws(() => assertWindowsPrivatePath(f.file), /filesystem permissions/);
    assert.equal(sourcePublicationEpoch(f.root), "initial");
    assertWindowsPrivatePath(f.file);
  } finally { f.dispose(); }
});

test("source observer is lazy, reads live mutations, and closes without acquiring more state", () => {
  const f = fixture(), observer = new SourceGateObserver(f.root);
  try {
    assert.equal(observer.state().status, "ready");
    assert.equal(existsSync(path.dirname(f.file)), false, "observing a fresh clone creates no private state");
    publishSourceSnapshot(f.root, "initial", () => undefined);
    assert.equal(observer.state().epoch, "initial");
    withSourceWriteSync(f.root, () => {
      assert.equal(observer.state().status, "busy");
      assert.equal(observer.state().ownerPid, process.pid);
    });
    const current = observer.state();
    assert.equal(current.status, "ready");
    assert.notEqual(current.epoch, "initial");
    observer.close(); observer.close();
    assert.equal(observer.state().status, "unavailable");
    // Native Windows permits removal only after the owned SQLite handle closes.
    renameSync(path.dirname(f.file), path.join(f.root, "closed-state"));
    assert.equal(observer.state().status, "unavailable");
  } finally { observer.close(); f.dispose(); }
});

test("source observer refuses replaced or newly linked state instead of reopening another database", context => {
  const f = fixture(), observer = new SourceGateObserver(f.root);
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    assert.equal(observer.state().status, "ready");
    const directory = path.dirname(f.file), moved = path.join(f.root, "previous-state");
    try {
      renameSync(directory, moved);
      mkdirSync(directory);
      copyFileSync(path.join(moved, "coordination.sqlite"), f.file);
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      context.diagnostic("Native Windows prevented replacing the held SQLite directory; a real hard-link change exercises fail-closed observation.");
      linkSync(f.file, path.join(f.root, "linked-coordination.sqlite"));
    }
    assert.equal(observer.state().status, "unavailable");
    assert.equal(observer.state().status, "unavailable", "replacement requires explicit restart/inspection");
  } finally { observer.close(); f.dispose(); }
});

test("source observer refuses another checkout's coordination state", () => {
  const first = fixture(), second = fixture(), observer = new SourceGateObserver(second.root);
  try {
    publishSourceSnapshot(first.root, "initial", () => undefined);
    mkdirSync(path.dirname(second.file), { recursive: true });
    copyFileSync(first.file, second.file);
    assert.equal(observer.state().status, "unavailable");
  } finally { observer.close(); first.dispose(); second.dispose(); }
});

test("source observer rechecks its live checkout binding", () => {
  const f = fixture(), observer = new SourceGateObserver(f.root);
  try {
    publishSourceSnapshot(f.root, "initial", () => undefined);
    assert.equal(observer.state().status, "ready");
    const db = new DatabaseSync(f.file);
    try { db.prepare("UPDATE coordination SET root=? WHERE singleton=1").run(path.join(f.root, "another-checkout")); }
    finally { db.close(); }
    assert.equal(observer.state().status, "unavailable");
  } finally { observer.close(); f.dispose(); }
});
