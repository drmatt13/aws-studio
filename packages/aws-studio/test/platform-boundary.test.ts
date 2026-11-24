import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { APP_FRONTEND_PATHS, APP_PACKAGES } from "../scripts/platform-boundary";

/**
 * Platform code serves whichever project it runs for: it loads that project's configuration by
 * root (loadFrameworkConfig), never by a path relative to where the platform code itself lives,
 * and finds the project through frameworkRepositoryRoot, which an installer or launcher can set.
 */

const repository = path.resolve(__dirname, "../../..");
const PLATFORM = ["packages/aws-studio/src", "packages/aws-studio/scripts", "packages/aws-studio/local/api/src", "packages/aws-studio/local/websocket/src", "packages/aws-studio/local/invocation/src", "scripts", "packages/aws-studio/cdk"];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(file);
    return /\.(?:ts|mts|cts|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

const files = () => PLATFORM.flatMap(area => sources(path.join(repository, area)));
const relative = (file: string) => path.relative(repository, file).replaceAll(path.sep, "/");

test("platform code never imports an application's framework.config by relative path", () => {
  const offenders = files().filter(file => /(?:from\s+|import\(\s*|require\(\s*)["'](?:\.\.?\/)+framework\.config(?:\.ts)?["']/.test(readFileSync(file, "utf8"))).map(relative);
  assert.deepEqual(offenders, []);
});

test("CDK factories find the project through frameworkRepositoryRoot, which a launcher can set", () => {
  const offenders = sources(path.join(repository, "packages/aws-studio/cdk")).filter(file => /findRepositoryRoot\(__dirname\)/.test(readFileSync(file, "utf8"))).map(relative);
  assert.deepEqual(offenders, []);
});

const appFiles = new Set([
  "framework.config.ts", "codegen.ts", "graphql.config.ts", "graphql-chain.review.json",
  "docker-compose.yml", "docker-compose.services.yml", "client-app",
]);
const appPaths = [
  "framework-config", "compute", "cdk-app", "packages/api-contract",
  "packages/database", "packages/framework-generated", "packages/models",
  ...APP_FRONTEND_PATHS.map(entry => entry.toLowerCase()),
];

function isApplicationPath(file: string): boolean {
  const normalized = file.toLowerCase();
  return appFiles.has(normalized) || appPaths.some(entry => normalized === entry || normalized.startsWith(entry + "/"));
}

test("the platform checkout contains no application project or workspace", () => {
  const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  }).split("\0");
  assert.deepEqual(candidates.filter(isApplicationPath), []);
  const lock = JSON.parse(readFileSync(path.join(repository, "package-lock.json"), "utf8")) as { packages: Record<string, { link?: boolean; resolved?: string; workspaces?: string[] }> };
  const studioDirectory = "client-app";
  assert.deepEqual(Object.keys(lock.packages).filter(entry => entry !== studioDirectory && isApplicationPath(entry)), [], "The platform lock contains application workspace entries.");
  assert.ok(lstatSync(path.join(repository, studioDirectory)).isDirectory());
  for (const file of ["client-app/package.json", "client-app/server/index.ts", "client-app/src/main.tsx"]) {
    assert.ok(candidates.includes(file), `The platform includes ${file}`);
    assert.ok(lstatSync(path.join(repository, file)).isFile(), `Expected a physical Studio file at ${file}`);
  }
  const studio = JSON.parse(readFileSync(path.join(repository, "client-app/package.json"), "utf8")) as {
    name: string; private: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
  };
  assert.equal(studio.name, "framework-studio");
  assert.equal(studio.private, true);
  const dependencies = { ...studio.dependencies, ...studio.devDependencies, ...studio.optionalDependencies, ...studio.peerDependencies };
  assert.deepEqual([...APP_PACKAGES, "@repo/framework-generated"].filter(name => Object.hasOwn(dependencies, name)), []);
  assert.ok(lock.packages[""]?.workspaces?.includes(studioDirectory));
  assert.ok(Object.hasOwn(lock.packages, studioDirectory));
  assert.equal(lock.packages["framework-studio"], undefined);
  assert.equal(lock.packages["node_modules/framework-studio"]?.link, true);
  assert.equal(lock.packages["node_modules/framework-studio"]?.resolved, studioDirectory);
  assert.equal(lock.packages["node_modules/client-app"], undefined);
});

test("application path checks reject legacy bare names and frontend markers", () => {
  for (const entry of ["framework-config", "compute", "cdk-app", "packages/models", "client-app", "client-app/src/api", "client-app/src/routes/index.tsx", "CLIENT-APP/SRC/ROUTETREE.GEN.TS"]) {
    assert.ok(isApplicationPath(entry), entry);
  }
  for (const entry of ["client-app/package.json", "client-app/server/index.ts", "client-app/src/main.tsx"]) {
    assert.equal(isApplicationPath(entry), false, entry);
  }
});
