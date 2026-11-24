import assert from "./support/assert";
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { projectModules } from "../server/project-modules";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IncompatibleProjectError, resolveStudioProject } from "../server/project";
import { studioInstallation, type FrameworkCompatibility } from "../server/project-release";

/** Create a physical synthetic release with inspectable exports in each app. */
function project(root: string, name: string, options: { framework?: boolean; version?: string; compatibility?: FrameworkCompatibility } = {}): string {
  const directory = path.join(root, name);
  const version = options.version ?? "2.0.0";
  const spec = `file:vendor/aws-studio-${version}.tgz`;
  const manifest = { name, private: true, dependencies: { "aws-studio": spec } };
  mkdirSync(path.join(directory, "framework-config"), { recursive: true });
  writeFileSync(path.join(directory, "framework.config.ts"), `throw new Error("APPLICATION_CODE_EVALUATED");\n`);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "": manifest, "node_modules/aws-studio": { version, resolved: spec, integrity: "sha512-test" },
  } }));
  if (options.framework !== false) {
    const framework = path.join(directory, "node_modules/aws-studio");
    mkdirSync(framework, { recursive: true });
    const exports = {
      "./config": "./config.cjs", "./config/project-declarations": "./declarations.cjs",
      "./deploy/stateful-resources": "./resources.cjs", "./deploy/stateful-references": "./references.cjs", "./cli": "./run.cjs",
    };
    writeFileSync(path.join(framework, "package.json"), JSON.stringify({ name: "aws-studio", version, studioCompatibility: options.compatibility, exports, bin: { "aws-studio": "./run.cjs" } }));
    for (const entry of Object.values(exports)) writeFileSync(path.join(framework, entry), `module.exports = { owner: ${JSON.stringify(name)} };\n`);
  }
  return realpathSync(directory);
}

function fixture<T>(use: (root: string) => T): T {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-project-")));
  try { return use(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("--project opens that directory, ahead of STUDIO_PROJECT and the working directory", () => fixture((root) => {
  const named = project(root, "named"), environment = project(root, "environment"), here = project(root, "here");
  assert.equal(resolveStudioProject({ args: ["--project", named], env: { STUDIO_PROJECT: environment }, cwd: here }).root, named);
  assert.equal(resolveStudioProject({ args: ["--project", "named"], env: {}, cwd: root }).root, named, "a relative path is relative to the working directory");
  assert.equal(resolveStudioProject({ args: [], env: { STUDIO_PROJECT: environment }, cwd: here }).root, environment);
}));

test("without a named project, the project is the one containing the working directory", () => fixture((root) => {
  const here = project(root, "here");
  mkdirSync(path.join(here, "framework-config/workloads"));
  assert.equal(resolveStudioProject({ args: [], env: {}, cwd: path.join(here, "framework-config/workloads") }).root, here);
}));

test("Studio refuses its installation and nested projects before inspecting project declarations", () => fixture((outside) => {
  const cache = path.join(studioInstallation, ".cache");
  mkdirSync(cache, { recursive: true });
  const inside = mkdtempSync(path.join(cache, "project-placement-"));
  try {
    const nested = project(inside, "nested"), alias = path.join(outside, "nested-alias");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(nested, alias, linkType);
    // Placement must win even when reading the nested pin would fail.
    writeFileSync(path.join(nested, "package.json"), "invalid JSON");
    for (const root of [studioInstallation, nested, alias]) {
      assert.throws(() => resolveStudioProject({ args: ["--project", root], env: {}, cwd: outside }), /outside.*--project/);
      assert.throws(() => resolveStudioProject({ args: [], env: { STUDIO_PROJECT: root }, cwd: outside }), /outside.*--project/);
      assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: root }), /--project <dir>/);
    }
    if (process.platform === "win32") {
      assert.throws(() => resolveStudioProject({ args: ["--project", nested.toUpperCase()], env: {}, cwd: outside }), /outside.*--project/);
    }
    const external = project(outside, "external"), externalAlias = path.join(inside, "external-alias");
    symlinkSync(external, externalAlias, linkType);
    assert.equal(resolveStudioProject({ args: ["--project", externalAlias], env: {}, cwd: outside }).root, external);
  } finally {
    // This unique fixture contains a junction. Recursive removal unlinks it without following it.
    rmSync(inside, { recursive: true, force: true });
  }
}));

test("the project's framework installation is reported with it", () => fixture((root) => {
  const here = project(root, "here");
  assert.equal(resolveStudioProject({ args: [], env: {}, cwd: here }).framework, realpathSync(path.join(here, "node_modules/aws-studio")));
}));

test("a directory without the project marker files is not opened", () => fixture((root) => {
  mkdirSync(path.join(root, "plain"));
  writeFileSync(path.join(root, "plain/package.json"), "{}");
  assert.throws(() => resolveStudioProject({ args: ["--project", path.join(root, "plain")], env: {}, cwd: root }), (error: unknown) => error instanceof IncompatibleProjectError && /is not an AWS Studio project: it has no framework\.config\.ts/.test(error.message));
  assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: path.join(root, "plain") }), IncompatibleProjectError);
}));

test("a project that has not installed its framework says to install it", () => fixture((root) => {
  const bare = project(root, "bare", { framework: false });
  assert.throws(() => resolveStudioProject({ args: ["--project", bare], env: {}, cwd: root }), (error: unknown) => error instanceof IncompatibleProjectError && /npm install/.test(error.message));
}));

test("--project needs a directory", () => {
  assert.throws(() => resolveStudioProject({ args: ["--project"], env: {}, cwd: os.tmpdir() }), /--project needs a directory/);
  assert.throws(() => resolveStudioProject({ args: ["--project", "--port"], env: {}, cwd: os.tmpdir() }), /--project needs a directory/);
});

test("Studio reports the required version before resolving the project's framework exports", () => fixture((root) => {
  const newer = project(root, "newer", { version: "8.0.0", compatibility: { minimumStudio: "99.0.0", protocol: 1, capabilities: [] } });
  rmSync(path.join(newer, "node_modules/aws-studio/config.cjs"));
  assert.throws(() => resolveStudioProject({ args: ["--project", newer], env: {}, cwd: root }), /requires AWS Studio version 99\.0\.0 or higher/);
}));

test("a supported release must match the app's own lockfile", () => fixture((root) => {
  const here = project(root, "pinned");
  const spec = "file:vendor/aws-studio-2.0.0.tgz";
  const manifest = { dependencies: { "aws-studio": spec } };
  writeFileSync(path.join(here, "package.json"), JSON.stringify(manifest));
  const lock = (version: string) => writeFileSync(path.join(here, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": manifest, "node_modules/aws-studio": { version, resolved: spec, integrity: "sha512-test" } } }));
  lock("99.0.0");
  assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: here }), /must match package-lock\.json/);
  lock("2.0.0");
  assert.deepEqual(resolveStudioProject({ args: [], env: {}, cwd: here }).release, { version: "2.0.0", spec, section: "dependencies" });
}));

test("an unknown legacy pin names the offending release before evaluating project code", () => fixture((root) => {
  const app = project(root, "legacy", { version: "1.9.1" });
  writeFileSync(path.join(app, "node_modules/aws-studio/config.cjs"), 'throw new Error("FRAMEWORK_CODE_EVALUATED");');
  assert.throws(() => {
    resolveStudioProject({ args: [], env: {}, cwd: app });
    createRequire(path.join(app, "package.json"))("./framework.config.ts");
  }, (error: unknown) => error instanceof IncompatibleProjectError && /no compatibility information/.test(error.message) && error.message.includes("file:vendor/aws-studio-1.9.1.tgz"));
}));

test("an external app must declare one release pin even when its framework is present", () => fixture((root) => {
  const app = project(root, "unversioned");
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "unversioned" }));
  assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: app }), /pin aws-studio once/i);
}));

test("the installed release must match the pinned name and version", () => fixture((root) => {
  const app = project(root, "mismatch"), file = path.join(app, "node_modules/aws-studio/package.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  for (const update of [{ name: "other" }, { version: "2.0.1" }]) {
    writeFileSync(file, JSON.stringify({ ...original, ...update }));
    assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: app }), /installed.*aws-studio 2\.0\.0/i);
  }
}));

test("the opened release provides every required public export before evaluating app code", () => fixture((root) => {
  const app = project(root, "partial"), file = path.join(app, "node_modules/aws-studio/package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  delete manifest.exports["./deploy/stateful-references"];
  writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: app }), /aws-studio\/deploy\/stateful-references/);
}));

test("a project must install its own physical release inside node_modules", () => fixture((root) => {
  const app = project(root, "linked", { framework: false }), other = project(root, "separate");
  mkdirSync(path.join(app, "node_modules"));
  symlinkSync(path.join(other, "node_modules/aws-studio"), path.join(app, "node_modules/aws-studio"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveStudioProject({ args: [], env: {}, cwd: app }), /physical|directly in/i);
}));

test("two apps with independent 2.x installations read their own declarations and exported modules", () => fixture((root) => {
  for (const name of ["first", "second"]) {
    const app = project(root, name);
    mkdirSync(path.join(app, "framework-config/auth"), { recursive: true });
    writeFileSync(path.join(app, "framework-config/auth/sign-in-providers.ts"), `export const SIGN_IN_PROVIDERS = { ${name}: {} };\n`);
    const selected = resolveStudioProject({ args: [], env: {}, cwd: app });
    assert.equal(selected.framework, path.join(app, "node_modules/aws-studio"));
    const modules = projectModules(app);
    assert.deepEqual(Object.keys(modules.signInCatalog().SIGN_IN_PROVIDERS), [name]);
    assert.deepEqual(modules.framework(), { owner: name });
    assert.deepEqual(modules.statefulResources(), { owner: name });
    assert.deepEqual(modules.databaseLifecycle(), { owner: name });
  }
}));
