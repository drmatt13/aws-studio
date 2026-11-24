import { testProjectRoot, testProjectScratch } from "../../../../../scripts/test-project";
import { copyIsolatedProject } from "./isolated-project";
import { after } from "node:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Handler directories a test writes for itself and removes afterwards.
 *
 * Kept under compute/.cache, never beside the real handlers. Tests that
 * synthesize a service or a task stage the repository root as its Docker build
 * context while this file's tests run in parallel, and `.dockerignore` and
 * `.gitignore` both exclude `**\/.cache`: a fixture appearing or vanishing
 * mid-copy can neither fail that copy nor be left behind as an undeclared
 * handler when a run is killed.
 */

let isolatedRoot: string | undefined;
after(() => {
  if (isolatedRoot) rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function sourceFixtureRoot(): string {
  if (isolatedRoot) return isolatedRoot;
  const root = testProjectScratch("cdk-source-");
  copyIsolatedProject(testProjectRoot, root, { physicalRelease: true });
  process.env.FRAMEWORK_REPOSITORY_ROOT = root;
  isolatedRoot = root;
  return root;
}

/** The repository-relative compute path of a fixture tool in this run. */
export function toolFixtureDirectory(run: string, id: string): `compute/${string}` {
  return `compute/.cache/test-fixtures/${run}/tools/${id}`;
}

/** The framework path of a fixture agent in this run. */
export function agentFixtureDirectory(run: string, id: string): `compute/${string}` {
  return `compute/.cache/test-fixtures/${run}/agents/${id}`;
}

/** Writes each fixture's index.ts; the answer removes the run's directories. */
export function writeSourceFixtures(
  run: string,
  sources: { readonly tools?: Readonly<Record<string, string>>; readonly agents?: Readonly<Record<string, string>> },
): () => void {
  const root = sourceFixtureRoot();
  const write = (directory: string, source: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "index.ts"), source);
  };
  for (const [id, source] of Object.entries(sources.tools ?? {})) {
    write(path.join(root, toolFixtureDirectory(run, id)), source);
  }
  for (const [id, source] of Object.entries(sources.agents ?? {})) {
    write(path.join(root, agentFixtureDirectory(run, id)), source);
  }
  return () => {
    for (const directory of [path.join(root, "compute/.cache/test-fixtures", run)]) {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** Copy retained test sources inside compute for the duration of one test process. */
export function copySourceFixtures(run: string, ids: readonly string[]): { root: string; directory: (id: string) => `compute/${string}`; cleanup: () => void } {
  const root = sourceFixtureRoot();
  const directory = (id: string): `compute/${string}` => `compute/.cache/test-fixtures/${run}/${id}`;
  for (const id of ids) {
    cpSync(path.join(__dirname, "../fixtures", id), path.join(root, directory(id)), { recursive: true });
  }
  return { root, directory, cleanup: () => rmSync(path.join(root, "compute/.cache/test-fixtures", run), { recursive: true, force: true }) };
}

/** The smallest sources a tool and an agent fixture need. */
export const fixtureToolSource = "export const lambdaHandler = async () => ({});";
export const fixtureAgentSource = (id: string) => `export const handler = { kind: "framework-agent", id: ${JSON.stringify(id)} };`;
