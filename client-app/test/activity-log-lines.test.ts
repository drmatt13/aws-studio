import assert from "./support/assert";
import { test } from "node:test";
import type { JobLogLine } from "../shared/operations";
import { firstError, linkParts, logRows, problemCount, severityOf } from "../src/operations/log-lines";
import { LogStore } from "../src/operations/log-store";

let serial = 0;
const line = (text: string, stream: JobLogLine["stream"] = "out", seq = ++serial): JobLogLine => ({ seq, at: "2026-11-06T12:00:00.000Z", stream, text });
const bundling = (name: string) => [line(`Bundling asset app-Stack/${name}/Code/Stage...`, "err"), line("  ...1b92d-building/index.js  842b", "err"), line("  ...1b92d-building/index.js.map  1.5kb", "err"), line("⚡ Done in 1ms", "err")];

test("severity comes from what a line says, never from which stream carried it", () => {
  assert.equal(severityOf(line("Successfully synthesized to .cache/plans/x/assembly", "err")), "plain");
  assert.equal(severityOf(line("Number of stacks with differences: 5", "err")), "plain");
  assert.equal(severityOf(line("AccessDenied: User is not authorized", "err")), "error");
  assert.equal(severityOf(line("Error: could not connect", "err")), "error");
  assert.equal(severityOf(line("[WARNING] aws-cdk-lib.Function#foo is deprecated", "err")), "warning");
  assert.equal(severityOf(line("$ tsx scripts/deploy.ts --plan", "info")), "command");
  assert.equal(severityOf(line("Reading account", "info")), "note");
});

test("standard output is only flagged for an unmistakable problem", () => {
  assert.equal(severityOf(line("0 errors, handled by ErrorBoundary and failed-login tests")), "plain");
  assert.equal(severityOf(line("CloudFormation · app-Stack · Bucket CREATE_FAILED — Access denied", "info")), "error");
  assert.equal(severityOf(line("CloudFormation · app-Stack · UPDATE_ROLLBACK_IN_PROGRESS", "info")), "warning");
  assert.equal(severityOf(line("npm ERR! code ELIFECYCLE")), "error");
  assert.equal(severityOf(line("npm WARN deprecated rimraf@3")), "warning");
});

test("a local database preflight surfaces its actionable initialization diagnostic", () => {
  const notice = line("Local startup is incomplete. Containers already started and their data are preserved. No migrations or identity changes were requested.", "err");
  const diagnostic = line("Error: Local database needs initialization: no database signature was found. Open Database → Database status, inspect Local PostgreSQL, then review initialization.", "err");
  assert.equal(severityOf(notice), "plain");
  assert.equal(severityOf(diagnostic), "error");
  assert.equal(firstError([notice, diagnostic]), diagnostic);
});

test("a repeated classification reuses the first answer", () => {
  const entry = line("Error: once", "err");
  assert.equal(severityOf(entry), severityOf(entry));
});

test("bundling noise folds, keeps a true count, and every line stays reachable", () => {
  const before = line("$ tsx scripts/deploy.ts", "info");
  const assets = [...bundling("A"), ...bundling("B"), ...bundling("C")];
  const after = line("Successfully synthesized", "err");
  const rows = logRows([before, ...assets, after], { query: "", problemsOnly: false, opened: new Set() });
  assert.deepEqual(rows.map(row => row.kind), ["line", "fold", "line"]);
  const fold = rows[1]!;
  assert.ok(fold.kind === "fold");
  assert.equal(fold.label, "Bundled 3 assets");
  assert.equal(fold.lines.length, assets.length);
  const opened = logRows([before, ...assets, after], { query: "", problemsOnly: false, opened: new Set([fold.id]) });
  assert.equal(opened.filter(row => row.kind === "line").length, assets.length + 2);
  assert.equal(opened.filter(row => row.kind === "fold").length, 1, "its header stays, to close it again");
});

test("a problem is never folded away", () => {
  const lines = [...bundling("A"), line("  ...x/index.js  842b", "err"), line("Error: bundling failed", "err"), ...bundling("B")];
  const rows = logRows(lines, { query: "", problemsOnly: false, opened: new Set() });
  const shown = rows.flatMap(row => row.kind === "line" ? [row.line.text] : []);
  assert.ok(shown.includes("Error: bundling failed"));
});

test("too few lines are not worth a fold", () => {
  const rows = logRows(bundling("A").slice(0, 2), { query: "", problemsOnly: false, opened: new Set() });
  assert.ok(rows.every(row => row.kind === "line"));
});

test("filtering searches inside folds and problems narrow to what needs attention", () => {
  const warning = line("[WARNING] old", "err"), error = line("Error: broke", "err"), plain = line("all fine");
  const lines = [...bundling("Findable"), warning, plain, error];
  const found = logRows(lines, { query: "findable", problemsOnly: false, opened: new Set() });
  assert.deepEqual(found.map(row => row.kind === "line" ? row.line.text : "fold"), ["Bundling asset app-Stack/Findable/Code/Stage..."]);
  assert.deepEqual(logRows(lines, { query: "", problemsOnly: true, opened: new Set() }).map(row => row.kind === "line" ? row.line : undefined), [warning, error]);
  assert.deepEqual(logRows(lines, { query: "BROKE", problemsOnly: true, opened: new Set() }).map(row => row.kind === "line" ? row.line : undefined), [error]);
  assert.equal(problemCount(lines), 2);
});

test("the first error is the earliest, because later ones usually follow from it", () => {
  const root = line("Error: root cause", "err");
  assert.equal(firstError([line("fine"), root, line("Error: fallout", "err")]), root);
  assert.equal(firstError([line("fine")]), undefined);
});

test("only safe, useful destinations become links", () => {
  const url = linkParts("Local: http://127.0.0.1:5173/ ready", "/repo");
  assert.deepEqual(url, ["Local: ", { text: "http://127.0.0.1:5173/", href: "http://127.0.0.1:5173/" }, " ready"]);
  const stack = "arn:aws:cloudformation:us-east-1:123456789012:stack/app-Stack/abc-123";
  assert.deepEqual(linkParts(`Stack ${stack}`, "/repo")[1], { text: stack, href: `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/stackinfo?stackId=${encodeURIComponent(stack)}` });
  assert.deepEqual(linkParts("arn:aws:lambda:us-east-1:123456789012:function:app", "/repo"), ["arn:aws:lambda:us-east-1:123456789012:function:app"], "no console address is guessed");
  assert.deepEqual(linkParts("framework-config/http.ts:12:3 - error TS2322", "/repo")[0], { text: "framework-config/http.ts:12:3", href: "vscode://file//repo/framework-config/http.ts:12:3" });
  assert.deepEqual(linkParts("at run (/repo/scripts/deploy.ts:44:9)", "/repo")[1], { text: "/repo/scripts/deploy.ts:44:9", href: "vscode://file//repo/scripts/deploy.ts:44:9" });
  assert.deepEqual(linkParts("javascript:alert(1)", "/repo"), ["javascript:alert(1)"]);
  assert.deepEqual(linkParts("/etc/passwd:1", "/repo"), ["/etc/passwd:1"], "only this checkout opens in the editor");
  assert.deepEqual(linkParts("framework-config/http.ts:12", undefined), ["framework-config/http.ts:12"], "no root, no link");
});

test("appending to a log neither copies out of order nor disturbs other jobs", () => {
  const store = new LogStore();
  store.add("a", [line("one", "out", 1), line("two", "out", 2)]);
  const other = store.get("b");
  store.add("a", [line("three", "out", 3)]);
  assert.deepEqual(store.get("a").map(entry => entry.seq), [1, 2, 3]);
  assert.equal(store.get("b"), other, "an untouched job keeps its identity, so its reader does not render");
  const before = store.get("a");
  store.add("a", [line("late", "out", 2)]);
  assert.equal(store.get("a"), before, "a duplicate changes nothing");
  store.add("a", [line("five", "out", 5), line("four", "out", 4)]);
  assert.deepEqual(store.get("a").map(entry => entry.seq), [1, 2, 3, 4, 5], "a replay can arrive out of order");
});

test("a long log keeps its latest lines and its identity changes when it grows", () => {
  const store = new LogStore();
  store.add("a", Array.from({ length: 5200 }, (_, index) => line(`line ${index + 1}`, "out", index + 1)));
  const held = store.get("a");
  assert.equal(held.length, 5000);
  assert.equal(held[0]!.seq, 201);
  store.add("a", [line("next", "out", 5201)]);
  assert.notEqual(store.get("a"), held);
  assert.equal(store.get("a").length, 5000);
  assert.equal(store.get("a").at(-1)!.seq, 5201);
});
