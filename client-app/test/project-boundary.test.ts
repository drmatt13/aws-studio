import assert from "./support/assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { runtimeSpecifiers, typescriptFiles } from "./support/runtime-imports";

const studio = path.resolve(__dirname, "..");
const repository = path.resolve(studio, "..");

/**
 * Paths that belong to the application Studio has open, not to Studio. Studio may describe their
 * types, but executable code from them must come from the opened project at run time (see
 * server/project-modules.ts). The platform's client-app directory contains Studio itself.
 */
const APPLICATION = ["framework.config.ts", "framework-config/", "cdk-app/", "compute/"];

test("Studio code never executes this checkout's application modules", async () => {
  const problems: string[] = [];
  for (const area of ["server", "shared", "src"]) {
    for (const file of await typescriptFiles(path.join(studio, area))) {
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const name of runtimeSpecifiers(source)) {
        if (!name.startsWith(".")) continue;
        const target = path.relative(repository, path.resolve(path.dirname(file), name)).replaceAll(path.sep, "/");
        if (APPLICATION.some(prefix => prefix.endsWith("/") ? target.startsWith(prefix) : target === prefix || target === prefix.replace(/\.ts$/, ""))) {
          problems.push(`${path.relative(studio, file).replaceAll(path.sep, "/")} imports ${target}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], "Load application modules through projectModules(root) so Studio reads the project it opened.");
});

test("Studio and the invocation runner reach the framework only through its package exports", async () => {
  const { allSpecifiers } = await import("./support/runtime-imports");
  const problems: string[] = [];
  const areas = [["client-app", ["server", "shared", "src", "test", "scripts"]], ["local-invocation-runner", ["src", "test"]]] as const;
  for (const [workspace, folders] of areas) for (const folder of folders) {
    const directory = path.join(repository, workspace, folder);
    for (const file of await typescriptFiles(directory).catch(() => [] as string[])) {
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const name of allSpecifiers(source)) {
        if (!name.startsWith(".")) continue;
        const target = path.relative(repository, path.resolve(path.dirname(file), name)).replaceAll(path.sep, "/");
        // Framework test helpers are fixtures, not the framework's surface.
        if (target.startsWith("packages/aws-studio/") && !target.startsWith("packages/aws-studio/test/")) problems.push(`${path.relative(repository, file).replaceAll(path.sep, "/")} imports ${target}`);
      }
    }
  }
  assert.deepEqual(problems, [], "Import aws-studio/<entry>; add an explicit export when Studio needs a module, so the surface Studio depends on is versioned with the framework.");
});
