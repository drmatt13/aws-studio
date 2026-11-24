import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Where platform code lives in the platform checkout.
 * Platform code serves whichever project it runs for; it never imports an application file.
 */
export const PLATFORM_PATHS = [
  "packages/aws-studio",
  "scripts",
  "client-app/server",
  "client-app/shared",
  "client-app/src",
  "client-app/scripts",
  "client-app/vite.config.mts",
] as const;

/** Paths specific to the application frontend that previously occupied client-app/. */
export const APP_FRONTEND_PATHS = [
  "client-app/.cta.json",
  "client-app/.env.example",
  "client-app/.vscode",
  "client-app/dev-proxy.ts",
  "client-app/public/logo192.png",
  "client-app/public/logo512.png",
  "client-app/public/manifest.json",
  "client-app/public/og",
  "client-app/public/robots.txt",
  "client-app/public/theme-init.js",
  "client-app/src/api",
  "client-app/src/client.tsx",
  "client-app/src/components",
  "client-app/src/lib",
  "client-app/src/router.tsx",
  "client-app/src/routes",
  "client-app/src/routeTree.gen.ts",
  "client-app/vite.config.ts",
] as const;

/** The reference application's files. */
export const APP_PATHS = [
  "framework.config.ts",
  "framework-config",
  "compute",
  ...APP_FRONTEND_PATHS,
  "cdk-app/bin",
  "cdk-app/lib/app",
  "cdk-app/lib/application.ts",
  "cdk-app/framework-inputs.ts",
  "packages/database",
  "packages/models",
  "packages/api-contract",
  "packages/framework-generated",
] as const;

/** Application packages, by name. `@repo/framework-generated` is the framework's declared peer. */
export const APP_PACKAGES = ["@repo/database", "@repo/models", "@repo/api-contract", "client-app"] as const;

export interface PlatformAppImport { readonly file: string; readonly line: number; readonly target: string }

const GENERATED_PACKAGE = "@repo/framework-generated";
const SKIPPED = new Set(["node_modules", "dist", "test", "generated", ".dist"]);
const SOURCE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const posix = (value: string) => value.split(path.sep).join("/").replace(/\\/g, "/");
const within = (target: string, list: readonly string[]) => list.some(entry => target === entry || target.startsWith(`${entry}/`));
const withoutExtension = (target: string) => target.replace(/\.(?:[cm]?ts|tsx|[cm]?js|json)$/, "");

function sources(root: string, relative: string, found: string[]): void {
  const absolute = path.join(root, relative);
  let stats;
  try { stats = statSync(absolute); } catch { return; }
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absolute)) if (!SKIPPED.has(entry)) sources(root, `${relative}/${entry}`, found);
  } else if (SOURCE.test(relative) && !/\.test\.[cm]?[jt]sx?$/.test(relative) && !relative.endsWith(".d.ts")) found.push(relative);
}

/** Module specifiers a file really imports: declarations, re-exports, import types, require() and import(). */
export function importSpecifiers(fileName: string, text: string): readonly { specifier: string; line: number }[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: { specifier: string; line: number }[] = [];
  const add = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) found.push({ specifier: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node) && node.arguments.length > 0 && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]!);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A same-stem source file can coexist with a legacy application path. */
function resolvesToPlatformFile(repository: string, file: string, specifier: string, stem: string): boolean {
  const { resolvedModule } = ts.resolveModuleName(specifier, path.join(repository, file), {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }, ts.sys);
  if (!resolvedModule) return false;

  const physical = posix(path.relative(realpathSync(repository), realpathSync(resolvedModule.resolvedFileName)));
  return physical !== stem && withoutExtension(physical) === stem
    && within(physical, PLATFORM_PATHS) && !within(physical, APP_PATHS);
}

/** Every import from platform code into the application, as repository-relative POSIX paths. */
export function platformAppImports(root: string): readonly PlatformAppImport[] {
  const nativeRoot = path.resolve(root);
  const repository = existsSync(nativeRoot) ? nativeRoot : path.resolve(posix(root));
  if (!statSync(repository).isDirectory()) throw new Error(`Expected a repository directory: ${repository}`);

  const manifest = path.join(repository, "packages/aws-studio/package.json");
  const hasGeneratedPeer = existsSync(manifest) && Object.hasOwn(
    (JSON.parse(readFileSync(manifest, "utf8")) as { peerDependencies?: Record<string, string> }).peerDependencies ?? {},
    GENERATED_PACKAGE,
  );
  const files: string[] = [];
  for (const entry of PLATFORM_PATHS) sources(repository, entry, files);
  const result: PlatformAppImport[] = [];
  for (const file of files) {
    for (const { specifier, line } of importSpecifiers(file, readFileSync(path.join(repository, file), "utf8"))) {
      let target: string | undefined;
      if (specifier.startsWith(".")) {
        const resolved = posix(path.posix.normalize(path.posix.join(path.posix.dirname(file), posix(specifier))));
        const stem = withoutExtension(resolved);
        const matchesAppStem = APP_PATHS.some(entry => withoutExtension(entry) === stem);
        const matchesAppPath = within(resolved, APP_PATHS);
        if (matchesAppPath || within(stem, APP_PATHS) || matchesAppStem) {
          const specifiesAppFile = resolved !== stem && matchesAppPath;
          if (specifiesAppFile || !matchesAppStem || !resolvesToPlatformFile(repository, file, specifier, stem)) target = stem;
        }
      } else if (within(specifier, [GENERATED_PACKAGE])) {
        if (!hasGeneratedPeer || !file.startsWith("packages/aws-studio/")) target = specifier;
      } else if (within(specifier, APP_PACKAGES)) target = specifier;
      if (target) result.push({ file, line, target });
    }
  }
  return result;
}

if (require.main === module) {
  const found = platformAppImports(process.argv[2] ?? ".");
  for (const entry of found) process.stdout.write(`${entry.file} -> ${entry.target}\n`);
  process.stdout.write(`${found.length} imports in ${new Set(found.map(entry => entry.file)).size} files\n`);
}
