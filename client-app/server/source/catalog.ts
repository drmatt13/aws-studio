import { nativeVpcReferences } from "./networks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ModelResource, SourceIndex, SourceLocation } from "../../shared/model";
import { toRelative } from "../files";
import { expressionAt, lineAndColumn, literalKey, parse, unwrap } from "./syntax";
import { descriptorFactory, frameworkExport } from "./factories";
import type { LocatedConfigSource } from "aws-studio/source-index";

/**
 * What the catalog's source says that its evaluated value cannot.
 *
 * `stack<T>()` mints members on access, so the evaluated catalog knows
 * only the members something reads. The class `T` knows them all: its public
 * fields are the catalog's entries, exactly as `StackResourceKeys<T>` reads
 * them. And a catalog entry is bound to its construct by a `linkResources`
 * call in application CDK, which only that source shows.
 */

export interface StackMember {
  readonly name: string;
  readonly typeText: string;
  readonly category: "construct" | "value" | "secret";
  readonly location: SourceLocation;
  readonly assignments?: readonly SourceLocation[];
  readonly networkPlacement?: ModelResource["networkPlacement"];
  readonly networkId?: string;
}

export interface CatalogEntrySource {
  /** The entry's declaration in its input or native catalog. */
  readonly key: SourceLocation;
  readonly value: SourceLocation;
  /** `PROD_DEPLOYMENT ? … : undefined`: the condition under which the entry exists. */
  readonly condition?: string;
  /** For `stack<T>()`, the class and its public members. */
  readonly stack?: { readonly className: string; readonly location?: SourceLocation; readonly members: readonly StackMember[]; readonly networkIds?: readonly string[] };
  readonly stackUsage?: ModelResource["stackUsage"];
}

function locate(repositoryRoot: string, sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  const start = node.getStart(sourceFile);
  return { file: toRelative(repositoryRoot, sourceFile.fileName), ...lineAndColumn(sourceFile, start), start, end: node.end };
}

function moduleFile(from: string, specifier: string, exists: (file: string) => boolean = existsSync): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  return [...(/\.[jt]s$/.test(base) ? [base.replace(/\.js$/, ".ts")] : []), `${base}.ts`, path.join(base, "index.ts")].find((candidate) => exists(candidate));
}

function importedFrom(sourceFile: ts.SourceFile, name: string): { specifier: string; exported: string } | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const binding = bindings.elements.find((element) => element.name.text === name);
      if (binding) return { specifier: statement.moduleSpecifier.text, exported: binding.propertyName?.text ?? binding.name.text };
    }
  }
  return undefined;
}

/** The `T` of `stack<T>()` anywhere inside an entry's value. */
function stackClassName(source: ts.SourceFile, value: ts.Expression): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      descriptorFactory(source, node) === "stack"
    ) {
      const argument = node.typeArguments?.[0];
      if (argument && ts.isTypeReferenceNode(argument)) found = argument.typeName.getText();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(value);
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function categorize(typeText: string): StackMember["category"] {
  if (typeText === "string") return "value";
  if (/\bI?Secret\b/.test(typeText)) return "secret";
  return "construct";
}

/** A stack class's public fields and getters: the members `StackResourceKeys<T>` would read. */
export function stackMembers(repositoryRoot: string, file: string, className: string) {
  const sourceFile = parse(file, readFileSync(file, "utf8"));
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!declaration) return undefined;
  const vpcs = nativeVpcReferences(repositoryRoot, sourceFile, declaration);
  const memberVpcs = new Map<string, string>();
  const placements = new Map<string, ModelResource["networkPlacement"]>();
  const readPlacement = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isNewExpression(node.right)) {
      const options = node.right.arguments?.[2];
      const property = (value: ts.Node | undefined, name: string): ts.Expression | undefined => {
        const item = value && ts.isObjectLiteralExpression(value) ? value.properties.find(item => literalKey(item) === name) : undefined;
        return item && ts.isPropertyAssignment(item) ? item.initializer : item && ts.isShorthandPropertyAssignment(item) ? item.name : undefined;
      };
      const network = vpcs.resolve(property(options, "vpc"));
      if (network) memberVpcs.set(node.left.name.text, network);
      const selection = property(property(options, "vpcSubnets"), "subnetType");
      const subnetTypes: Readonly<Record<string, NonNullable<ModelResource["networkPlacement"]>>> = { PUBLIC: "public", PRIVATE_WITH_EGRESS: "private", PRIVATE_ISOLATED: "isolated" };
      const subnet = selection && ts.isPropertyAccessExpression(selection) ? subnetTypes[selection.name.text] : undefined;
      if (subnet) placements.set(node.left.name.text, subnet);
    }
    ts.forEachChild(node, readPlacement);
  };
  readPlacement(declaration);
  const members: StackMember[] = [];
  for (const member of declaration.members) {
    if (!ts.isPropertyDeclaration(member) && !ts.isGetAccessorDeclaration(member)) continue;
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    if ([ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword].some((kind) => hasModifier(member, kind))) {
      continue;
    }
    const typeText = member.type?.getText(sourceFile) ?? "unknown";
    members.push({ name: member.name.text, typeText, category: categorize(typeText), location: locate(repositoryRoot, sourceFile, member.name), networkPlacement: placements.get(member.name.text), networkId: memberVpcs.get(member.name.text) });
  }
  return { className, location: locate(repositoryRoot, sourceFile, declaration.name ?? declaration), members, networkIds: [...vpcs.used] };
}

/**
 * Every catalog entry's source, keyed by catalog path (`cognito`, `langgraph.modelProvider`).
 *
 * `span` is where `defineInputs(...)` or `defineStacks(...)` is, as the config-source locator found it.
 */
export function readCatalogSource(
  repositoryRoot: string,
  file: string,
  span: { readonly start: number; readonly end: number },
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): Map<string, CatalogEntrySource> {
  const entries = new Map<string, CatalogEntrySource>();
  const sourceFile = parse(file, read(file));
  const call = expressionAt(sourceFile, span.start, span.end);
  const unwrapped = call ? unwrap(call) : undefined;
  if (!unwrapped || !ts.isCallExpression(unwrapped) || !["defineInputs", "defineStacks"].includes(frameworkExport(sourceFile, unwrapped.expression) ?? "")) return entries;
  const argument = unwrapped.arguments[0] ? unwrap(unwrapped.arguments[0]) : undefined;
  if (!argument || !ts.isObjectLiteralExpression(argument)) return entries;

  const resolve = (source: ts.SourceFile, expression: ts.Expression, seen = new Set<string>()): { source: ts.SourceFile; expression: ts.Expression } => {
    const value = unwrap(expression);
    if (!ts.isIdentifier(value)) return { source, expression: value };
    const identity = `${source.fileName}:${value.text}`;
    if (seen.has(identity)) throw new Error(`The resource declaration ${value.text} contains a circular source alias.`);
    seen.add(identity);
    const local = source.statements.filter(ts.isVariableStatement).filter(statement => !!(statement.declarationList.flags & ts.NodeFlags.Const)).flatMap(statement => [...statement.declarationList.declarations]).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === value.text);
    if (local?.initializer) return resolve(source, local.initializer, seen);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".") || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      const binding = bindings && ts.isNamedImports(bindings) ? bindings.elements.find(binding => binding.name.text === value.text && !binding.isTypeOnly) : undefined;
      if (!binding) continue;
      const target = moduleFile(source.fileName, statement.moduleSpecifier.text, candidate => { try { read(candidate); return true; } catch { return false; } });
      if (!target || !path.resolve(target).startsWith(path.join(path.resolve(repositoryRoot), "framework-config") + path.sep)) return { source, expression: value };
      const imported = parse(target, read(target));
      const name = binding.propertyName?.text ?? binding.name.text;
      const declaration = imported.statements.filter(ts.isVariableStatement).filter(statement => !!(statement.declarationList.flags & ts.NodeFlags.Const) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).flatMap(statement => [...statement.declarationList.declarations]).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
      return declaration?.initializer ? resolve(imported, declaration.initializer, seen) : { source, expression: value };
    }
    return { source, expression: value };
  };
  const visit = (source: ts.SourceFile, object: ts.ObjectLiteralExpression, prefix: readonly string[]): void => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const name = literalKey(property);
      if (name === undefined) continue;
      const path = [...prefix, name];
      const resolved = resolve(source, ts.isPropertyAssignment(property) ? property.initializer : property.name);
      const value = resolved.expression;
      const owner = resolved.source;
      const condition = ts.isConditionalExpression(value) ? value.condition.getText(owner) : undefined;
      const className = stackClassName(owner, value);
      const imported = className ? importedFrom(owner, className) : undefined;
      const classFile = imported ? moduleFile(owner.fileName, imported.specifier) : undefined;
      const stack = className
        ? classFile
          ? stackMembers(repositoryRoot, classFile, imported?.exported ?? className) ?? { className, members: [] }
          : { className, members: [] }
        : undefined;
      entries.set(path.join("."), {
        key: locate(repositoryRoot, source, property.name),
        value: locate(repositoryRoot, owner, value),
        ...(condition ? { condition } : {}),
        ...(stack ? { stack } : {}),
      });
      if (ts.isObjectLiteralExpression(value) && prefix.length === 0) visit(owner, value, path);
    }
  };
  visit(sourceFile, argument, []);
  return entries;
}

/** Separate authored catalogs share the existing unprefixed normalized identities. */
export function readConfiguredCatalog(repositoryRoot: string, located: LocatedConfigSource, read: (file: string) => string): Map<string, CatalogEntrySource> {
  const entries = new Map<string, CatalogEntrySource>();
  for (const name of ["inputs", "stacks"] as const) {
    const catalog = located.properties[name];
    if (!catalog) continue;
    for (const [key, entry] of readCatalogSource(repositoryRoot, catalog.file, catalog.span, read)) {
      if (entries.has(key)) throw new Error(`The input and stack catalogs both declare ${key}.`);
      entries.set(key, entry);
    }
  }
  return entries;
}

const LINK_MODULES = new Map([
  ["linkResources", "aws-studio/cdk/framework-resources"],
  ["linkResource", "aws-studio/cdk/framework-resources"],
  ["bindPostgresDatabase", "aws-studio/cdk/framework-database"],
]);
const LINK_MODULE_NAMES = new Set(LINK_MODULES.values());

export function typeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "cdk.out") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...typeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(absolute);
  }
  return files;
}

/**
 * Where application CDK binds each catalog entry to its construct.
 *
 * Keyed by the catalog path the call names: `linkResources(this,
 * stacks.cognito)` binds `cognito`; `linkResource(this,
 * stacks.jobs, queue)` binds `jobs`.
 */
export function readResourceLinks(
  repositoryRoot: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
  configured?: { readonly file: string; readonly span: { readonly start: number; readonly end: number } },
): { readonly sites: Map<string, SourceLocation[]>; readonly analysis: NonNullable<SourceIndex["linkAnalysis"]> } {
  const sites = new Map<string, SourceLocation[]>();
  const groups = new Set<string>();
  const unknown: NonNullable<SourceIndex["linkAnalysis"]>["unknown"][number][] = [];
  let complete = true;
  const sources = new Map<string, ts.SourceFile>();
  const sourceAt = (file: string): ts.SourceFile | undefined => {
    const key = path.resolve(file);
    if (sources.has(key)) return sources.get(key);
    try {
      const source = parse(key, read(key));
      sources.set(key, source);
      if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) complete = false;
      return source;
    } catch { complete = false; return undefined; }
  };
  type Symbol = { kind: "catalog"; path: string[]; dynamic?: boolean } | { kind: "foreignCatalog" } | { kind: "namespace"; file: string } | { kind: "link"; name: string };
  const linkModule = (from: string, specifier: string) =>
    LINK_MODULE_NAMES.has(specifier) ? specifier : moduleFile(from, specifier);
  const resolveExport = (file: string, name: string, seen: Set<string>): Symbol | undefined => {
    if (LINK_MODULE_NAMES.has(file)) return LINK_MODULES.get(name) === file ? { kind: "link", name } : undefined;
    const identity = `${file}#${name}`;
    if (seen.has(identity)) return undefined;
    const next = new Set([...seen, identity]);
    const source = sourceAt(file);
    if (!source) return undefined;
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration?.initializer) return resolve(source, declaration.initializer, next);
      }
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? linkModule(file, statement.moduleSpecifier.text) : file;
      if (!target) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const binding = statement.exportClause.elements.find(item => !item.isTypeOnly && item.name.text === name);
        if (binding) return statement.moduleSpecifier
          ? resolveExport(target, binding.propertyName?.text ?? binding.name.text, next)
          : resolve(source, binding.propertyName ?? binding.name, next);
      } else if (!statement.exportClause) {
        const found = resolveExport(target, name, next);
        if (found) return found;
      }
    }
    return undefined;
  };
  const resolve = (source: ts.SourceFile, expression: ts.Expression, seen = new Set<string>()): Symbol | undefined => {
    const value = unwrap(expression);
    if (ts.isCallExpression(value) && frameworkExport(source, value.expression) === "defineStacks") {
      if (configured && (path.resolve(source.fileName) !== path.resolve(configured.file) || value.getStart(source) !== configured.span.start || value.end !== configured.span.end)) return { kind: "foreignCatalog" };
      return { kind: "catalog", path: [] };
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const base = resolve(source, value.expression, seen);
      const key = ts.isPropertyAccessExpression(value) ? value.name.text
        : value.argumentExpression && ts.isStringLiteralLike(unwrap(value.argumentExpression)) ? (unwrap(value.argumentExpression) as ts.StringLiteralLike).text : undefined;
      if (base?.kind === "namespace") return key ? resolveExport(base.file, key, seen) : undefined;
      if (base?.kind === "foreignCatalog") return base;
      if (base?.kind === "catalog") return { ...base, path: key && !base.dynamic ? [...base.path, key] : base.path, dynamic: base.dynamic || !key };
      return undefined;
    }
    if (!ts.isIdentifier(value)) return undefined;
    const identity = `${source.fileName}:${value.text}:${value.getStart(source)}`;
    if (seen.has(identity)) return undefined;
    const next = new Set([...seen, identity]);
    // Respect lexical aliases and shadowing; mutable variables and parameters are unknown.
    for (let scope: ts.Node | undefined = value.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === value.text)) return undefined;
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      const statement = scope.statements.filter(ts.isVariableStatement).find(item => item.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === value.text));
      const declaration = statement?.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === value.text);
      if (declaration) return statement!.declarationList.flags & ts.NodeFlags.Const && declaration.initializer ? resolve(source, declaration.initializer, next) : undefined;
    }
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      const target = linkModule(source.fileName, statement.moduleSpecifier.text);
      if (!target || !bindings) continue;
      if (ts.isNamespaceImport(bindings) && bindings.name.text === value.text) return { kind: "namespace", file: target };
      if (ts.isNamedImports(bindings)) {
        const binding = bindings.elements.find(item => !item.isTypeOnly && item.name.text === value.text);
        if (binding) return resolveExport(target, binding.propertyName?.text ?? binding.name.text, next);
      }
    }
    return undefined;
  };
  const uncertain = (source: ts.SourceFile, node: ts.Node, catalogPath: readonly string[] | undefined, reason: string): void => {
    const at = locate(repositoryRoot, source, node);
    const key = catalogPath?.join(".") || undefined;
    if (!unknown.some(item => item.path === key && item.source?.file === at.file && item.source.start === at.start)) unknown.push({ ...(key ? { path: key } : {}), source: at, reason });
  };
  const files = [
    ...typeScriptFiles(path.join(repositoryRoot, "cdk-app", "lib")),
    ...typeScriptFiles(path.join(repositoryRoot, "cdk-app", "bin")),
  ];
  for (const file of files) {
    const sourceFile = sourceAt(file);
    if (!sourceFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const helper = resolve(sourceFile, node.expression);
        const reference = node.arguments[1] && resolve(sourceFile, node.arguments[1]);
        if (helper?.kind === "link" && reference?.kind === "catalog" && reference.path.length && !reference.dynamic) {
          const key = reference.path.join(".");
          const list = sites.get(key) ?? [];
          list.push(locate(repositoryRoot, sourceFile, node));
          sites.set(key, list);
          if (helper.name === "linkResources") groups.add(key);
        } else if (reference?.kind !== "foreignCatalog" || helper?.kind !== "link") {
          let references = 0;
          const inspect = (item: ts.Node): void => {
            if (ts.isExpression(item)) {
              const result = resolve(sourceFile, item);
              if (result?.kind === "catalog") {
                references++;
                uncertain(sourceFile, node, result.path, helper?.kind === "link" ? "The native link uses a computed catalog reference." : "This catalog reference is passed through custom code whose native linking cannot be verified.");
                return;
              }
            }
            ts.forEachChild(item, inspect);
          };
          node.arguments.forEach(inspect);
          // Generic helper parameters cannot identify which catalog entry they link.
          if (helper?.kind === "link" && !references) uncertain(sourceFile, node, undefined, "A native link uses an unresolved reference or custom helper parameter.");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { sites, analysis: { complete, groups: [...groups], unknown } };
}

/** Compatibility view used by source evidence and CDK relationship inference. */
export function readLinkSites(repositoryRoot: string, read: (file: string) => string = (file) => readFileSync(file, "utf8")): Map<string, SourceLocation[]> {
  return readResourceLinks(repositoryRoot, read).sites;
}
