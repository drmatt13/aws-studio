import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GraphQLTagPluckOptions } from "@graphql-tools/graphql-tag-pluck";

export type DocumentPluckOptions = Pick<GraphQLTagPluckOptions, "modules" | "gqlMagicComment" | "gqlVueBlock" | "globalGqlIdentifierName" | "skipIndent">;
const allowed = new Set(["modules", "gqlMagicComment", "gqlVueBlock", "globalGqlIdentifierName", "skipIndent"]);
export function isDocumentPluckOptions(value: unknown): value is DocumentPluckOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) return false;
  const options = value as DocumentPluckOptions;
  return (options.skipIndent === undefined || typeof options.skipIndent === "boolean")
    && [options.gqlMagicComment, options.gqlVueBlock].every(item => item === undefined || typeof item === "string" && item.length <= 256)
    && (options.globalGqlIdentifierName === undefined || typeof options.globalGqlIdentifierName === "string" && options.globalGqlIdentifierName.length <= 256 || Array.isArray(options.globalGqlIdentifierName) && options.globalGqlIdentifierName.length <= 100 && options.globalGqlIdentifierName.every(item => typeof item === "string" && item.length <= 256))
    && (options.modules === undefined || Array.isArray(options.modules) && options.modules.length <= 100 && options.modules.every(item => item && typeof item.name === "string" && item.name.length <= 512 && (item.identifier === undefined || typeof item.identifier === "string" && item.identifier.length <= 256) && Object.keys(item).every(key => ["name", "identifier"].includes(key))));
}
/** Called only inside the full native checker, after evaluating Codegen config.
 * Unknown loader behavior declines the fast path instead of executing it in the watcher. */
export function documentProjectionOptions(config: Record<string, any>): DocumentPluckOptions | null {
  const rootKeys = new Set(["schema", "documents", "generates", "config", "overwrite", "ignoreNoDocuments", "pluckConfig", "noRequire"]);
  if (Object.keys(config).some(key => !rootKeys.has(key))) return null;
  const nested = config.config ?? {};
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const forbidden = ["loader", "loaders", "noPluck", "require", "cwd", "ignore", "filterKinds", "documents", "schema", "skipGraphQLImport"];
  if (forbidden.some(key => key in nested)) return null;
  const options = { skipIndent: true, ...(nested.pluckConfig ?? config.pluckConfig ?? {}) };
  return isDocumentPluckOptions(options) ? JSON.parse(JSON.stringify(options)) as DocumentPluckOptions : null;
}

/** Cover the declared Codegen subtree conservatively, excluding only its root output.
 * Hidden names are retained because loader options can enable dot entries. */
function authoredDocumentPaths(root: string): string[] {
  const files: string[] = [], base = path.join(root, "client-app/src/api");
  let entries = 0;
  const visit = (directory: string): void => {
    let children;
    try { children = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (directory === base && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of children) {
      const file = path.join(directory, entry.name), name = path.relative(root, file).split(path.sep).join("/");
      if (name === "client-app/src/api/generated") continue;
      if (++entries > 500_000) throw new Error("Authored document inputs exceed the bounded inventory.");
      if (entry.isSymbolicLink()) throw new Error("Linked authored document inputs are unsupported.");
      if (entry.isDirectory()) visit(file);
      else if (name.endsWith(".ts")) {
        if (!entry.isFile()) throw new Error("Authored document inputs must be regular files.");
        files.push(name);
      }
    }
  };
  visit(base);
  return files;
}

/** Refuse a smaller private tree than the declared Codegen document glob.
 * This reads only names; private or runtime files never enter source capture. */
export function assertCapturedAuthoredDocuments(root: string, captured: Readonly<Record<string, unknown>>): void {
  for (const name of authoredDocumentPaths(root)) if (!Object.hasOwn(captured, name)) throw new Error(`A Codegen document input is excluded from public source capture: ${name}. Move authored operations outside private or runtime directories.`);
}

export function readAuthoredDocumentSources(root: string): Record<string, string> {
  return Object.fromEntries(authoredDocumentPaths(root).map(name => [name, readFileSync(path.join(root, name), "utf8")]));
}

/** The same syntax guard runs for full validation and presentation-only plucking. */
export function inspectAuthoredDocumentSyntax(root: string, sources: Readonly<Record<string, string>>, authored?: ReadonlySet<string>): void {
  const localRequire = createRequire(path.join(root, "package.json"));
  const ts = localRequire("typescript") as typeof import("typescript"), graphql = localRequire("graphql") as typeof import("graphql");
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const verifyDiscovery = !!authored;
  for (const [name, contents] of Object.entries(sources)) {
    const file = path.join(root, name);
    const syntax = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
    const helpers = new Set(["graphql"]);
    const namespaces = new Set<string>();
    const generatedHelpers = new Set<string>();
    const executors = new Set<string>(), executorNamespaces = new Set<string>();
    const generatedDirectory = path.join(root, "client-app/src/api/generated");
    const generatedImport = (name: string): boolean => {
      const reference = name.startsWith(".") ? path.resolve(path.dirname(file), name) : name;
      return ["#/api/generated", "#/api/generated/index", "#/api/generated/gql", generatedDirectory,
        path.join(generatedDirectory, "index"), path.join(generatedDirectory, "gql")].includes(reference.replace(/\.(?:ts|js)$/, ""));
    };
    for (const statement of syntax.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "graphql") {
        if (statement.importClause?.name) { executorNamespaces.add(statement.importClause.name.text); executors.add(statement.importClause.name.text); }
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) { executorNamespaces.add(bindings.name.text); executors.add(bindings.name.text); }
        if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) if ((specifier.propertyName ?? specifier.name).text === "graphql") executors.add(specifier.name.text);
      }
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !generatedImport(statement.moduleSpecifier.text)) continue;
      if (statement.importClause?.name) namespaces.add(statement.importClause.name.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
        if ((specifier.propertyName ?? specifier.name).text === "graphql") { helpers.add(specifier.name.text); generatedHelpers.add(specifier.name.text); }
      }
    }
    // The GraphQL executor is an ordinary object-argument function, often
    // used by API tests. It is not the generated document helper.
    const executorImport = (node: import("typescript").Node): boolean => {
      const expression = ts.isAwaitExpression(node) ? node.expression : node;
      return ts.isCallExpression(expression) && (expression.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(expression.expression) && expression.expression.text === "require") && expression.arguments.length === 1 && ts.isStringLiteral(expression.arguments[0]!) && expression.arguments[0]!.text === "graphql";
    };
    const collectExecutors = (node: import("typescript").Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && executorImport(node.initializer)) {
        if (ts.isIdentifier(node.name)) { executorNamespaces.add(node.name.text); executors.add(node.name.text); }
        if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) if (ts.isIdentifier(binding.name) && (binding.propertyName ?? binding.name).getText(syntax) === "graphql") executors.add(binding.name.text);
      }
      ts.forEachChild(node, collectExecutors);
    };
    collectExecutors(syntax);
    for (const executor of executors) if (!generatedHelpers.has(executor)) helpers.delete(executor);
    const executorMember = (node: import("typescript").PropertyAccessExpression | import("typescript").ElementAccessExpression) => ts.isIdentifier(node.expression) && executorNamespaces.has(node.expression.text) && !namespaces.has(node.expression.text);
    const visit = (node: import("typescript").Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && namespaces.has(node.text)) throw new Error(`Unsupported member graphql document helper in ${relative(file)}. Import graphql directly and use a literal document.`);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && generatedImport(node.arguments[0].text)) {
        throw new Error(`Unsupported indirect graphql helper import in ${relative(file)}. Use a static named import.`);
      }
      if ((ts.isPropertyAccessExpression(node) && node.name.text === "graphql" && !executorMember(node))
        || (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "graphql" && !executorMember(node))) {
        throw new Error(`Unsupported member graphql document helper in ${relative(file)}. Import graphql directly and use a literal document.`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
        const argument = node.arguments[0];
        if (node.arguments.length !== 1 || !argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) throw new Error(`Unsupported dynamic graphql() document in ${relative(file)}.`);
        graphql.parse(new graphql.Source(argument.text, relative(file)));
        if (verifyDiscovery && !authored!.has(argument.text.replaceAll("\r\n", "\n"))) throw new Error(`Codegen did not discover a graphql() document in ${relative(file)}.`);
      }
      if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && helpers.has(node.tag.text)) throw new Error(`Unsupported graphql tagged document in ${relative(file)}.`);
      if (ts.isIdentifier(node) && helpers.has(node.text) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && executorMember(node.parent))) {
        throw new Error(`Unsupported graphql helper reference in ${relative(file)}. Call the imported helper directly with a literal document.`);
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  }
}

/** Uses Codegen's actual plucker, including its skipIndent default; no source module is imported. */
export function projectAuthoredDocuments(root: string, sources: Readonly<Record<string, string>>, options: DocumentPluckOptions): string {
  if (!isDocumentPluckOptions(options)) throw new Error("Unsupported document projection options.");
  const localRequire = createRequire(path.join(root, "package.json"));
  const { gqlPluckFromCodeStringSync } = localRequire("@graphql-tools/graphql-tag-pluck") as typeof import("@graphql-tools/graphql-tag-pluck");
  const graphql = localRequire("graphql") as typeof import("graphql");
  inspectAuthoredDocumentSyntax(root, sources);
  const authored = new Set<string>();
  for (const [file, contents] of Object.entries(sources)) for (const source of gqlPluckFromCodeStringSync(file, contents, options)) {
    const document = graphql.parse(source);
    if (document.definitions.some(definition => definition.kind === "OperationDefinition" || definition.kind === "FragmentDefinition")) authored.add(source.body.replaceAll("\r\n", "\n"));
  }
  inspectAuthoredDocumentSyntax(root, sources, authored);
  return createHash("sha256").update(JSON.stringify([...authored].sort())).digest("hex");
}
