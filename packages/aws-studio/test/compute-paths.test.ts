import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defineFrameworkConfig,
  getFrameworkTargets,
  normalizeFrameworkDirectory,
  type ComputeDirectory,
  type FrameworkHttp,
  type FrameworkServices,
  type UrlPath,
} from "../src/config";
import {
  assertLambdaInventory,
  findRepositoryRoot,
  resolveAgentSourcePath,
  resolveFrameworkDirectory,
  resolveTargetSources,
} from "../src/config/source";
import { lambdaDirectoriesById } from "../scripts/source-inventory";

const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const config = () => defineFrameworkConfig({ defaults, http: [{ "/public": { directory: "compute/http/shared", methods: ["GET"] } }], webSocket: [], events: [{ event: {} }], tools: [{ tool: {} }], services: [], tasks: [], agents: [{ agent: { directory: "compute/shared/agent" } }] });

/** Source paths and public paths cannot be interchanged by typed callers. */
function pathTypes(directory: ComputeDirectory, route: UrlPath) {
  // @ts-expect-error A URL is not an implementation directory.
  const invalidDirectory: ComputeDirectory = route;
  // @ts-expect-error A source directory is not a public URL.
  const invalidRoute: UrlPath = directory;
  const http: FrameworkHttp = { "/public": { directory, methods: ["GET"] } };
  const services: FrameworkServices = {};
  return { invalidDirectory, invalidRoute, http, services };
}
void pathTypes;

test("compute paths are portable repository-relative paths and preserve target identity", () => {
  assert.equal(normalizeFrameworkDirectory("compute/shared/nested/handler", "fixture"), "compute/shared/nested/handler");
  for (const invalid of ["/compute/http/a", "C:/compute/http/a", "//host/compute/a", "compute\\http\\a", "compute/http/../a", "compute/./a", "compute//a", "compute/http/a/", "compute/http/a b", "compute", "http/a", "compute/http/a?b", "/agents/a"]) {
    assert.throws(() => normalizeFrameworkDirectory(invalid, "fixture"), /fixture/);
  }
  const targets = new Map(getFrameworkTargets(config()).map(target => [target.reference, target]));
  assert.equal(targets.get("lambda:shared")?.directory, "compute/http/shared");
  assert.equal(targets.get("lambda:event")?.directory, "compute/events/event");
  assert.equal(targets.get("lambda:tool")?.directory, "compute/tools/tool");
  assert.equal(targets.get("agent:agent")?.directory, "compute/shared/agent");
  assert.doesNotThrow(() => assertLambdaInventory(config(), ["compute/http/shared", "compute/events/event", "compute/tools/tool"]));
  assert.throws(() => assertLambdaInventory(config(), ["compute/websocket/orphan"]), /compute\/websocket\/orphan is not declared/);
});

test("repository discovery requires root declarations and package metadata, not a source tree", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compute-root-"));
  try {
    mkdirSync(path.join(root, "nested/child"), { recursive: true });
    writeFileSync(path.join(root, "framework.config.ts"), "export default {};\n");
    assert.throws(() => findRepositoryRoot(root), /framework.config.ts and package.json/);
    writeFileSync(path.join(root, "package.json"), '{"private":true}\n');
    assert.equal(findRepositoryRoot(path.join(root, "nested/child")), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Lambda inventory includes undeclared empty directories and excludes other compute kinds", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compute-inventory-"));
  try {
    for (const directory of ["compute/http/handler", "compute/websocket/authorizer", "compute/events/event", "compute/tools/tool", "compute/services/handler", "compute/tasks/task", "compute/agents/agent"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    assert.deepEqual([...lambdaDirectoriesById(root)], [
      ["authorizer", "compute/websocket/authorizer"], ["event", "compute/events/event"],
      ["handler", "compute/http/handler"], ["tool", "compute/tools/tool"],
    ]);
    mkdirSync(path.join(root, "compute/tools/handler"));
    assert.throws(() => lambdaDirectoriesById(root), /handler is both compute\/http\/handler and compute\/tools\/handler/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one resolver handles all compute kinds and rejects links escaping compute even for absent children", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compute-containment-"));
  try {
    for (const directory of ["compute/http/shared", "compute/events/event", "compute/tools/tool", "compute/shared/agent", "outside/existing"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    const options = { repositoryRoot: root };
    assert.equal(resolveAgentSourcePath(config(), "agent", options), path.join(root, "compute/shared/agent"));
    assert.equal(resolveTargetSources(config(), options).size, 4);
    assert.throws(() => resolveFrameworkDirectory("compute/http/absent", "fixture", options), /does not exist/);
    assert.equal(resolveFrameworkDirectory("compute/http/absent/nested", "fixture", { ...options, allowMissing: true }), path.join(root, "compute/http/absent/nested"));
    writeFileSync(path.join(root, "compute/http/file"), "not a directory");
    assert.throws(() => resolveFrameworkDirectory("compute/http/file", "fixture", { ...options, allowMissing: true }), /does not exist/);
    symlinkSync(path.join(root, "outside"), path.join(root, "compute/escape"), "junction");
    for (const directory of ["compute/escape/existing", "compute/escape/absent/nested"] as const) {
      assert.throws(() => resolveFrameworkDirectory(directory, "fixture", options), /resolves outside compute/);
      assert.throws(() => resolveFrameworkDirectory(directory, "fixture", { ...options, allowMissing: true }), /resolves outside compute/);
    }
    symlinkSync(path.join(root, "compute/shared"), path.join(root, "compute/inside"), "junction");
    assert.equal(resolveFrameworkDirectory("compute/inside/agent", "fixture", options), path.join(root, "compute/inside/agent"));
    mkdirSync(path.join(root, "outside/dangling-target"));
    symlinkSync(path.join(root, "outside/dangling-target"), path.join(root, "compute/dangling"), "junction");
    rmdirSync(path.join(root, "outside/dangling-target"));
    assert.throws(() => resolveFrameworkDirectory("compute/dangling/future", "fixture", { ...options, allowMissing: true }), /unresolved link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compute root junctions cannot redefine containment, including missing destinations", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compute-root-containment-"));
  try {
    const repositoryRoot = path.join(root, "repository");
    mkdirSync(repositoryRoot);
    mkdirSync(path.join(root, "outside/existing"), { recursive: true });
    symlinkSync(path.join(root, "outside"), path.join(repositoryRoot, "compute"), "junction");
    for (const directory of ["compute/existing", "compute/absent/nested"] as const) {
      assert.throws(() => resolveFrameworkDirectory(directory, "fixture", { repositoryRoot }), /resolves outside compute/);
      assert.throws(() => resolveFrameworkDirectory(directory, "fixture", { repositoryRoot, allowMissing: true }), /resolves outside compute/);
    }
    rmdirSync(path.join(root, "outside/existing"));
    rmdirSync(path.join(root, "outside"));
    assert.throws(() => resolveFrameworkDirectory("compute/future", "fixture", { repositoryRoot, allowMissing: true }), /unresolved link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a checkout opened through a junction keeps its real compute boundary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "compute-checkout-link-"));
  try {
    mkdirSync(path.join(root, "repository/compute/http/handler"), { recursive: true });
    const repositoryRoot = path.join(root, "checkout");
    symlinkSync(path.join(root, "repository"), repositoryRoot, "junction");
    assert.equal(resolveFrameworkDirectory("compute/http/handler", "fixture", { repositoryRoot }), path.join(repositoryRoot, "compute/http/handler"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
