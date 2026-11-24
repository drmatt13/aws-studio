import { platformSourceRoot, testProjectRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

/**
 * An application verifies its contract chain without Studio: `npm run contract:check` runs the
 * framework's verifier. The packaged CLI ships the same policy files with their relative paths.
 */

const repository = testProjectRoot, release = path.resolve(__dirname, "..");
const commands: { verify: [string, ...string[]][] } = require("../cli/commands.cjs");
const verifierEntries = ["cli/aws-studio.cjs", ...commands.verify.map(([entry]) => entry), "scripts/contract-chain/worker.ts", "scripts/contract-chain/node-test-reporter.ts"].map(name => path.join(release, name));
const relative = (file: string) => path.relative(release, file).replaceAll(path.sep, "/");

/** Every specifier a module can load or type against, including worker entries it names by URL. */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) names.push(node.argument.literal.text);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) names.push(node.arguments[0].text);
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "path" && node.expression.name.text === "join" && node.arguments[0]?.getText(source) === "__dirname" && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) names.push(`./${node.arguments[1].text}`);
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith(".")) names.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function resolveRelative(from: string, name: string): string | undefined {
  const base = path.resolve(path.dirname(from), name);
  for (const candidate of [base, base.replace(/\.(?:m?js)$/, ".ts"), `${base}.ts`, `${base}.mts`, `${base}.cjs`, `${base}.mjs`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Relative closure; aws-studio/* specifiers resolve through the framework's own exports. */
function closure(entries: readonly string[]): string[] {
  const exports = (JSON.parse(readFileSync(path.join(release, "package.json"), "utf8")) as { exports: Record<string, string> }).exports;
  const seen = new Set<string>(), pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:[cm]?ts|[cm]js)$/.test(file)) continue;
    for (const name of specifiers(file)) {
      let target: string | undefined;
      if (name.startsWith(".")) target = resolveRelative(file, name);
      else if (name.startsWith("aws-studio/")) {
        const entry = exports[`./${name.slice("aws-studio/".length)}`];
        target = entry ? path.join(release, entry) : undefined;
      }
      if (target && !seen.has(target)) pending.push(target);
    }
  }
  return [...seen].map(relative).sort();
}

test("contract verification executes and types against no Studio module", () => {
  for (const entry of verifierEntries) assert.ok(existsSync(entry), `${relative(entry)} exists`);
  const reached = closure(verifierEntries);
  assert.ok(reached.includes("scripts/contract-chain/inspector.ts"), "the closure follows the verifier");
  assert.deepEqual(reached.filter(file => file.startsWith("../")), []);
});

test("the proof policy names only the verifier the framework ships", () => {
  const { CONTRACT_PROOF_POLICY_FILES } = require("../scripts/contract-chain/portable-identity") as { CONTRACT_PROOF_POLICY_FILES: readonly string[] };
  assert.deepEqual(CONTRACT_PROOF_POLICY_FILES.filter(file => !["cli/", "scripts/", "database/", "src/"].some(prefix => file.startsWith(prefix))), []);
  assert.deepEqual(CONTRACT_PROOF_POLICY_FILES.filter(file => !existsSync(path.join(release, file))), []);
});

test("every module the verifier executes is part of the proof policy, so editing it invalidates receipts", () => {
  const { CONTRACT_PROOF_POLICY_FILES } = require("../scripts/contract-chain/portable-identity") as { CONTRACT_PROOF_POLICY_FILES: readonly string[] };
  const policy = new Set(CONTRACT_PROOF_POLICY_FILES);
  const reached = closure(verifierEntries);
  assert.deepEqual(reached.filter(file => !policy.has(file)), []);
});

test("the application's contract scripts run the framework's CLI", () => {
  const scripts = (JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["contract:check"], "aws-studio verify");
  assert.equal(scripts["contract:record"], "aws-studio record");
});

test("no workspace outside Studio imports Studio", () => {
  const studio = realpathSync(path.join(platformSourceRoot, "client-app"));
  const areas = ["packages", "cdk-app", "scripts", "compute", "client-app"].map(area => path.join(repository, area)).filter(existsSync);
  areas.push(path.join(platformSourceRoot, "packages"), path.join(platformSourceRoot, "scripts"));
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "generated" || entry.name.startsWith(".") ? [] : files(file);
    return /\.(?:[cm]?ts|tsx|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
  const targetsStudio = (file: string, name: string): boolean => {
    if (name === "framework-studio" || name.startsWith("framework-studio/")) return true;
    if (!name.startsWith(".")) return false;
    const target = resolveRelative(file, name);
    if (!target) return false;
    const fromStudio = path.relative(studio, realpathSync(target));
    return fromStudio !== ".." && !fromStudio.startsWith(".." + path.sep) && !path.isAbsolute(fromStudio);
  };
  const problems = areas.flatMap(files).flatMap(file => specifiers(file)
    .filter(name => targetsStudio(file, name))
    .map(name => `${relative(file)} imports ${name}`));
  assert.deepEqual(problems, []);
});
