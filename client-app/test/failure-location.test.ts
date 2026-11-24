import assert from "./support/assert";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { failureLocation } from "../server/model/failure-location";
import { failedModel } from "../server/model/project";

const root = path.resolve("/repo");
/** Build an error the way Node reports it: the stack is the only place a throw records its file. */
const thrown = (message: string, stack: string) => Object.assign(new Error(message), { stack });

test("a syntax error names the file and position the transformer reported", () => {
  const error = new Error('Transform failed with 1 error:\n/repo/framework-config/tasks/worker.ts:2:17: ERROR: Expected identifier but found ","');
  assert.deepEqual(failureLocation(error, root), { file: "framework-config/tasks/worker.ts", line: 2, column: 17 });
});

test("a missing module points at the file that imported it", () => {
  const error = new Error("Cannot find module './nope'\nRequire stack:\n- /repo/framework-config/tasks/worker.ts\n- /repo/framework.config.ts\n- /studio-install/client-app/server/evaluator/evaluate.ts");
  assert.deepEqual(failureLocation(error, root), { file: "framework-config/tasks/worker.ts", line: 1, column: 1 });
});

test("a thrown validation error resolves past the framework to the application's declaration", () => {
  const error = thrown("defineTask: memory must be a positive integer", [
    "Error: defineTask: memory must be a positive integer",
    "    at defineTask (/repo/packages/aws-studio/src/config/task.ts:41:11)",
    "    at Object.<anonymous> (/repo/framework-config/tasks/worker.ts:12:3)",
    "    at Module._compile (node:internal/modules/cjs/loader:1554:14)",
  ].join("\n"));
  assert.deepEqual(failureLocation(error, root), { file: "framework-config/tasks/worker.ts", line: 12, column: 3 });
});

test("a frame in the opened application's frontend gives its source location", () => {
  const error = thrown("bad", "Error: bad\n    at evaluate (/studio-install/client-app/server/evaluator/evaluate.ts:9:1)\n    at render (/repo/client-app/src/client.tsx:13:5)");
  assert.deepEqual(failureLocation(error, root), { file: "client-app/src/client.tsx", line: 13, column: 5 });
});

test("a stack frame written as a file URL is understood", () => {
  const url = pathToFileURL(path.join(root, "framework-config/tasks/worker.ts")).href;
  const error = thrown("bad", `Error: bad\n    at ${url}:7:9`);
  assert.deepEqual(failureLocation(error, root), { file: "framework-config/tasks/worker.ts", line: 7, column: 9 });
});

test("file URL frames decode spaces in application paths", () => {
  const url = pathToFileURL(path.join(root, "framework-config/tasks/worker with spaces.ts")).href;
  const error = thrown("bad", `Error: bad\n    at load (${url}:7:9)`);
  assert.deepEqual(failureLocation(error, root), { file: "framework-config/tasks/worker with spaces.ts", line: 7, column: 9 });
});

test("invalid file URL frames do not hide a later application location", () => {
  const invalid = pathToFileURL(path.join(root, "invalid%2Fworker.ts")).href.replace("%252F", "%2F");
  const valid = pathToFileURL(path.join(root, "framework-config/tasks/worker.ts")).href;
  const error = thrown("bad", `Error: bad\n    at ${invalid}:1:1\n    at ${valid}:7:9`);
  assert.deepEqual(failureLocation(error, root), { file: "framework-config/tasks/worker.ts", line: 7, column: 9 });
});

for (const [name, error] of [
  ["only tooling frames", thrown("bad", "Error: bad\n    at x (/repo/node_modules/tsx/dist/a.js:1:1)\n    at y (/studio-install/client-app/server/evaluator/evaluate.ts:9:1)")],
  ["a path outside the repository", new Error("Transform failed with 1 error:\n/elsewhere/worker.ts:2:17: ERROR: nope")],
  ["a sibling directory that shares the repository's prefix", new Error("Transform failed with 1 error:\n/repo-backup/worker.ts:2:17: ERROR: nope")],
  ["nothing to go on", thrown("bad", "Error: bad")],
  ["a value that is not an error", "a string failure"],
] as const)
  test(`no location is invented from ${name}`, () => {
    assert.equal(failureLocation(error, root), undefined);
  });

test("a failed model carries the location only when the repository is known", () => {
  const error = new Error("Transform failed with 1 error:\n/repo/worker.ts:2:17: ERROR: nope");
  assert.deepEqual(failedModel("dev", error, 0, root).diagnostics[0]?.location, { file: "worker.ts", line: 2, column: 17 });
  assert.equal(failedModel("dev", error, 0).diagnostics[0]?.location, undefined);
});
