import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  astFromValue, buildASTSchema, getLocation, isEnumType, isInputObjectType, isInterfaceType, isObjectType,
  isScalarType, isUnionType, lexicographicSortSchema, parse, print, printType, Source, visit,
  type DefinitionNode, type FragmentDefinitionNode, type GraphQLArgument as SchemaArgument,
  type GraphQLInputField, type GraphQLNamedType, type OperationDefinitionNode, type SelectionSetNode,
} from "graphql";
import type {
  GraphQLArgument, GraphQLClientExport, GraphQLDocument, GraphQLFeature, GraphQLSchemaInventory,
  GraphQLType, GraphQLWorkspace, WorkspaceDiagnostic,
} from "../../shared/graphql-workspace";

const API = "client-app/src/api";
const SCHEMA = "client-app/src/api/generated/schema.graphql" as const;
const GENERATED = `${API}/generated/graphql.ts`;
const GQL_MAP = `${API}/generated/gql.ts`;
const SERVER_SCHEMA = "compute/http/graphql-api/schema";
const SERVER_ENTRY = `${SERVER_SCHEMA}/index.ts`;
const MAX_FILE = 512 * 1024, MAX_TOTAL = 4 * 1024 * 1024, MAX_FILES = 256;
const cache = new Map<string, { metadata: string; value: GraphQLWorkspace }>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = <T extends { name: string }>(values: readonly T[]): T[] => [...values].sort((a, b) => a.name.localeCompare(b.name));
type Authored = { value: GraphQLDocument; definition: OperationDefinitionNode | FragmentDefinitionNode; binding: string | null };
const issue = (code: string, message: string, file?: string, line?: number): WorkspaceDiagnostic => ({ code, message, ...(file ? { file } : {}), ...(line ? { line } : {}) });

/** Inventory reads stay inside the fixed generated files and bounded API sources. */
function checkedPath(root: string, relative: string): string | null {
  let file = root;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    try { if (lstatSync(file).isSymbolicLink()) throw new Error("Linked GraphQL source is not supported."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  return file;
}
function readBounded(root: string, name: string): string | null {
  const file = checkedPath(root, name); if (!file) return null;
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_FILE)) throw new Error("GraphQL source must be a bounded regular file without links.");
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) { const size = readSync(descriptor, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(descriptor, { bigint: true });
    if (count !== Number(before.size) || after.size !== before.size || after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n) throw new Error("GraphQL source changed while reading. Check again.");
    return bytes.subarray(0, count).toString("utf8");
  } finally { closeSync(descriptor); }
}
function sourceInventory(root: string): { names: string[]; server: string[]; metadata: string; diagnostics: WorkspaceDiagnostic[]; present: boolean } {
  const names: string[] = [], server: string[] = [], facts: unknown[] = [], diagnostics: WorkspaceDiagnostic[] = []; let directories = 0, present = false;
  const describe = (name: string): void => {
    try {
      const file = checkedPath(root, name);
      if (!file) { facts.push([name, "missing"]); return; }
      const info = lstatSync(file, { bigint: true });
      facts.push([name, ...[info.dev, info.ino, info.mode, info.nlink, info.size, info.ctimeNs, info.mtimeNs].map(String)]);
    } catch { facts.push([name, "unavailable"]); diagnostics.push(issue("SOURCE_UNAVAILABLE", "Linked, unreadable or special source cannot be inspected.", name)); }
  };
  const scan = (directory: string, depth: number): void => {
    if (++directories > 128 || depth > 16) throw new Error("The API source directory exceeds the inventory limit.");
    const file = checkedPath(root, directory); if (!file) return;
    if (!lstatSync(file).isDirectory()) throw new Error("The API source path is not a directory.");
    present = true;
    for (const entry of readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "generated" && directory === API || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) { diagnostics.push(issue("LINKED_SOURCE", "Linked API source is not inspected.", name)); facts.push([name, "linked"]); continue; }
      if (entry.isDirectory()) scan(name, depth + 1);
      else if (entry.isFile() && name.endsWith(".ts")) { if (names.length >= MAX_FILES) throw new Error("The API source directory exceeds the file limit."); names.push(name); describe(name); }
    }
  };
  try { scan(API, 0); } catch (error) { diagnostics.push(issue("SOURCE_INVENTORY", error instanceof Error ? error.message : "API source is unavailable.", API)); }
  try {
    const directory = checkedPath(root, SERVER_SCHEMA);
    if (directory && lstatSync(directory).isDirectory()) {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (server.length >= MAX_FILES) throw new Error("The server schema exceeds the inventory limit.");
        const name = `${SERVER_SCHEMA}/${entry.name}`;
        server.push(name);
        describe(name);
      }
    }
  } catch { server.length = 0; facts.push([SERVER_SCHEMA, "unavailable"]); }
  for (const name of [SCHEMA, GENERATED, GQL_MAP]) describe(name);
  return { names, server, metadata: digest([facts, diagnostics]), diagnostics, present };
}

function argument(field: SchemaArgument | GraphQLInputField): GraphQLArgument {
  const value = field.defaultValue === undefined ? null : astFromValue(field.defaultValue, field.type);
  return { name: field.name, type: String(field.type), description: field.description ?? null, defaultValue: value ? print(value) : null };
}
function schemaType(type: GraphQLNamedType): GraphQLType {
  const base = { name: type.name, description: type.description ?? null, definition: printType(type), fields: [], enumValues: [], members: [], interfaces: [] };
  if (isObjectType(type) || isInterfaceType(type)) return { ...base, kind: isObjectType(type) ? "object" : "interface",
    fields: sorted(Object.values(type.getFields()).map(field => ({ name: field.name, type: String(field.type), description: field.description ?? null, defaultValue: null, args: sorted(field.args.map(argument)), deprecationReason: field.deprecationReason ?? null,
      ...(field.astNode?.loc ? { source: { file: SCHEMA, line: getLocation(field.astNode.loc.source, field.astNode.loc.start).line } } : {}) }))),
    interfaces: type.getInterfaces().map(item => item.name).sort() };
  if (isInputObjectType(type)) return { ...base, kind: "input", fields: sorted(Object.values(type.getFields()).map(field => ({ ...argument(field), args: [], deprecationReason: field.deprecationReason ?? null,
    ...(field.astNode?.loc ? { source: { file: SCHEMA, line: getLocation(field.astNode.loc.source, field.astNode.loc.start).line } } : {}) }))) };
  if (isEnumType(type)) return { ...base, kind: "enum", enumValues: sorted(type.getValues().map(value => ({ name: value.name, description: value.description ?? null, deprecationReason: value.deprecationReason ?? null }))) };
  if (isUnionType(type)) return { ...base, kind: "union", members: type.getTypes().map(value => value.name).sort() };
  if (isScalarType(type)) return { ...base, kind: "scalar" };
  throw new Error("Unsupported generated schema type.");
}
function schemaInventory(text: string | null, diagnostics: WorkspaceDiagnostic[]): GraphQLSchemaInventory {
  const empty = { file: SCHEMA, sdl: text, roots: { query: null, mutation: null, subscription: null }, types: [], diagnostics };
  if (text === null) return { ...empty, status: diagnostics.length ? "invalid" : "missing" };
  try {
    const schema = lexicographicSortSchema(buildASTSchema(parse(text)));
    return { status: "available", file: SCHEMA, sdl: text, diagnostics,
      roots: { query: schema.getQueryType()?.name ?? null, mutation: schema.getMutationType()?.name ?? null, subscription: schema.getSubscriptionType()?.name ?? null },
      types: sorted(Object.values(schema.getTypeMap()).filter(type => !type.name.startsWith("__")).map(schemaType)) };
  } catch { return { ...empty, status: "invalid", diagnostics: [...diagnostics, issue("SCHEMA_INVALID", "The generated schema cannot be parsed or its type references are invalid. Run npm run codegen after fixing the schema.", SCHEMA)] }; }
}
function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}
function literal(node: ts.Expression | undefined): string | null {
  if (!node) return null; node = unwrap(node);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}
const parseProblems = (file: ts.SourceFile) =>
  (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;

/** An empty model entry is meaningful only when every generated table type was accounted for. */
function tableTypeInventory(schema: GraphQLSchemaInventory, files: readonly string[], read: (name: string) => string | null) {
  if (schema.status !== "available" || !files.includes(SERVER_ENTRY)) return undefined;
  const source = read(SERVER_ENTRY);
  if (!source) return undefined;
  const entry = ts.createSourceFile(SERVER_ENTRY, source, ts.ScriptTarget.Latest, true);
  if (parseProblems(entry).length) return undefined;
  const published = new Set(schema.types.filter(type => type.kind === "object" && type.fields.some(field => field.name === "_access")).map(type => type.name));
  const mappings = new Map<string, string>();
  for (const statement of entry.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause) continue;
    const moduleName = literal(statement.moduleSpecifier);
    if (!moduleName || !/^\.\/[\w-]+$/.test(moduleName)) return undefined;
    const file = `${SERVER_SCHEMA}/${moduleName.slice(2)}.ts`;
    if (!files.includes(file)) return undefined;
    const text = read(file);
    if (!text) return undefined;
    const feature = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (parseProblems(feature).length) return undefined;
    const helpers = new Set<string>();
    for (const item of feature.statements) {
      if (!ts.isImportDeclaration(item) || literal(item.moduleSpecifier) !== "../lib/table-access") continue;
      const bindings = item.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) if ((binding.propertyName ?? binding.name).text === "tableObject") helpers.add(binding.name.text);
      }
    }
    let unsupported = false;
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
        const model = literal(node.arguments[0]), ref = node.arguments[1];
        const type = ref && ts.isCallExpression(ref) && ts.isPropertyAccessExpression(ref.expression) &&
          ref.expression.name.text === "objectRef" && literal(ref.arguments[0]);
        if (!model || !type || !published.has(type) || mappings.has(type)) unsupported = true;
        else mappings.set(type, model);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(feature);
    if (unsupported) return undefined;
  }
  if (mappings.size !== published.size) return undefined;
  const models = new Map<string, string[]>();
  for (const [type, model] of mappings) {
    const types = models.get(model) ?? [];
    types.push(type);
    models.set(model, types);
  }
  return Object.fromEntries([...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, types]) => [model, types.sort()]));
}
const exported = (statement: ts.VariableStatement) => statement.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword) ?? false;

function generatedDocuments(text: string | null): Map<string, { exportName: string; source: string; hash: string | null }> {
  const result = new Map<string, { exportName: string; source: string; hash: string | null }>(); if (!text) return result;
  const syntax = ts.createSourceFile(GENERATED, text, ts.ScriptTarget.Latest, true);
  for (const statement of syntax.statements) if (ts.isVariableStatement(statement) && exported(statement)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const node = unwrap(declaration.initializer);
    if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "TypedDocumentString") continue;
    const source = literal(node.arguments?.[0]); if (source === null) continue;
    let hash: string | null = null;
    const metadata = node.arguments?.[1];
    if (metadata && ts.isObjectLiteralExpression(metadata)) for (const item of metadata.properties) if (ts.isPropertyAssignment(item) && item.name.getText(syntax).replaceAll('"', "") === "hash") hash = literal(item.initializer);
    try {
      const { definitions } = parse(source);
      for (const definition of definitions) if ((definition.kind === "OperationDefinition" || definition.kind === "FragmentDefinition") && definition.name) {
      // An operation's typed string may bundle fragments; only bind the exported
      // operation itself, or the sole standalone fragment definition.
      if (definition.kind === "OperationDefinition" || definitions.length === 1) result.set(definition.name.value, { exportName: declaration.name.text, source, hash });
    } } catch { /* Invalid generated evidence is reported as unavailable per document. */ }
  }
  return result;
}
function generatedMap(text: string | null): Map<string, string> {
  const result = new Map<string, string>(); if (!text) return result;
  const syntax = ts.createSourceFile(GQL_MAP, text, ts.ScriptTarget.Latest, true);
  for (const statement of syntax.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "documents" || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
    for (const property of declaration.initializer.properties) if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isPropertyAccessExpression(property.initializer)) result.set(property.name.text, property.initializer.name.text);
  }
  return result;
}

function authoredFile(file: string, text: string, diagnostics: WorkspaceDiagnostic[]): { documents: Authored[]; feature: GraphQLFeature | null } {
  const syntax = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), documents: Authored[] = [];
  if (parseProblems(syntax).length) { diagnostics.push(issue("TYPESCRIPT_INVALID", "This API source has a syntax error; its inventory may be incomplete.", file)); return { documents, feature: null }; }
  const helpers = new Set(["graphql", "gql"]), queries = new Set<string>(), mutations = new Set<string>(), transports = new Set<string>();
  for (const statement of syntax.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const bindings = statement.importClause?.namedBindings;
    if (/(?:^|\/)generated(?:\/(?:index|gql))?(?:\.[jt]s)?$/.test(statement.moduleSpecifier.text)
      && (statement.importClause?.name || bindings && ts.isNamespaceImport(bindings))) diagnostics.push(issue("DOCUMENT_FORM", "Namespace/default generated-helper imports are not statically inspected. Use a named helper import.", file));
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const imported of bindings.elements) {
      const name = (imported.propertyName ?? imported.name).text;
      if (name === "graphql" || name === "gql") helpers.add(imported.name.text);
      if (statement.moduleSpecifier.text === "@tanstack/react-query" && name === "queryOptions") queries.add(imported.name.text);
      if (statement.moduleSpecifier.text === "@tanstack/react-query" && name === "mutationOptions") mutations.add(imported.name.text);
      if (name === "executeGraphQL" && (statement.moduleSpecifier.text === "#/api/graphql/client" || statement.moduleSpecifier.text.endsWith("/graphql/client"))) transports.add(imported.name.text);
    }
  }
  const line = (node: ts.Node) => syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1;
  const collect = (node: ts.Node): void => {
    let content: ts.Expression | undefined;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) content = node.arguments.length === 1 ? node.arguments[0] : undefined;
    else if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && helpers.has(node.tag.text)) content = node.template;
    else if ((ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) && (() => {
      const callee = ts.isCallExpression(node) ? node.expression : node.tag;
      return ts.isPropertyAccessExpression(callee) && ["graphql", "gql"].includes(callee.name.text)
        || ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteral(callee.argumentExpression) && ["graphql", "gql"].includes(callee.argumentExpression.text);
    })()) { diagnostics.push(issue("DOCUMENT_FORM", "Member GraphQL helpers are not statically inspected. Use a named helper import.", file, line(node))); return; }
    else { ts.forEachChild(node, collect); return; }
    const source = literal(content);
    if (source === null || !content) { diagnostics.push(issue("DOCUMENT_DYNAMIC", "This GraphQL document is dynamic and cannot be inspected without executing source.", file, line(node))); return; }
    let parent = node.parent;
    while (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) parent = parent.parent;
    const owner = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
    try {
      const parsed = parse(new Source(source, file));
      for (const definition of parsed.definitions) if (definition.kind === "OperationDefinition" || definition.kind === "FragmentDefinition") {
        if (documents.length >= 500) { diagnostics.push(issue("DOCUMENT_LIMIT", "This file has more documents than the inventory limit.", file)); break; }
        const name = definition.name?.value ?? "Anonymous operation", kind = definition.kind === "FragmentDefinition" ? "fragment" : definition.operation;
        const startLine = syntax.getLineAndCharacterOfPosition(content.getStart(syntax) + 1).line + 1;
        const definitionLine = startLine + (definition.loc ? getLocation(definition.loc.source, definition.loc.start).line - 1 : 0);
        const value: GraphQLDocument = { id: `${file}#${kind}:${name}:${definitionLine}`, name, kind, file, line: definitionLine,
          source: definition.loc ? source.slice(definition.loc.start, definition.loc.end) : print(definition), executableSource: null, fragmentNames: [], selections: [],
          generated: { status: "missing", exportName: null, source: null, hash: null }, diagnostics: [] };
        documents.push({ value, definition, binding: owner });
      }
    } catch { diagnostics.push(issue("DOCUMENT_INVALID", "A GraphQL document cannot be parsed.", file, line(node))); }
  };
  collect(syntax);
  if (!file.endsWith("/operations.ts")) return { documents, feature: null };
  const exports: GraphQLClientExport[] = [];
  for (const statement of syntax.statements) if (ts.isVariableStatement(statement) && exported(statement)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer), name = declaration.name.text;
    let kind: GraphQLClientExport["kind"] | null = null;
    if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
      if (queries.has(initializer.expression.text)) kind = "query-options";
      else if (mutations.has(initializer.expression.text)) kind = "mutation-options";
    }
    if (ts.isObjectLiteralExpression(initializer) && /Keys$/.test(name)) {
      const all = initializer.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(syntax) === "all");
      if (all && ts.isPropertyAssignment(all)) {
        const value = unwrap(all.initializer);
        if (ts.isArrayLiteralExpression(value) && value.elements.every(item => ts.isStringLiteral(item) || ts.isNumericLiteral(item) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(item.kind))) kind = "key-factory";
      }
    }
    if (!kind) continue;
    const references = new Set<string>();
    const bindings = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindings(element.name));
    const find = (node: ts.Node, shadowed: Set<string>): void => {
      const scope = new Set(shadowed);
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) for (const parameter of node.parameters) for (const binding of bindings(parameter.name)) scope.add(binding);
      if (ts.isBlock(node)) for (const statement of node.statements) if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) for (const binding of bindings(item.name)) scope.add(binding);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && transports.has(node.expression.text) && !scope.has(node.expression.text)) {
        const document = node.arguments[0]; if (document && ts.isIdentifier(document) && !scope.has(document.text)) references.add(document.text);
      }
      ts.forEachChild(node, child => find(child, scope));
    }; find(initializer, new Set());
    exports.push({ name, kind, line: line(declaration), documents: documents.filter(document => document.binding && references.has(document.binding)).map(document => document.value.id), expression: declaration.initializer.getText(syntax) });
  }
  return { documents, feature: { file, exports, documents: documents.map(document => document.value.id), queryOptions: exports.filter(value => value.kind === "query-options").map(value => value.name), mutationOptions: exports.filter(value => value.kind === "mutation-options").map(value => value.name), keyFactories: exports.filter(value => value.kind === "key-factory").map(value => value.name) } };
}

function completeDocuments(authored: Authored[], generated: ReturnType<typeof generatedDocuments>, maps: Map<string, string>, diagnostics: WorkspaceDiagnostic[]): GraphQLDocument[] {
  const fragments = new Map<string, Authored[]>();
  const mappedDefinitions = new Map<string, Set<string>>();
  for (const [source, exported] of maps) try {
    for (const definition of parse(source).definitions) {
      const key = print(definition); mappedDefinitions.set(key, new Set([...(mappedDefinitions.get(key) ?? []), exported]));
    }
  } catch { /* Malformed generated maps never provide matching evidence. */ }
  for (const document of authored) if (document.definition.kind === "FragmentDefinition") fragments.set(document.value.name, [...(fragments.get(document.value.name) ?? []), document]);
  return authored.map(({ value, definition }) => {
    const problems: WorkspaceDiagnostic[] = [], dependencies = new Map<string, FragmentDefinitionNode>();
    const resolve = (node: DefinitionNode, ancestors: Set<string>): void => { visit(node, { FragmentSpread(spread) {
      const name = spread.name.value, matches = fragments.get(name);
      if (!matches || matches.length !== 1) { problems.push(issue("FRAGMENT_UNAVAILABLE", `Fragment ${name} is missing or ambiguous.`, value.file, value.line)); return; }
      if (ancestors.has(name)) { problems.push(issue("FRAGMENT_CYCLE", `Fragment ${name} has a circular spread.`, value.file, value.line)); return; }
      if (dependencies.has(name)) return;
      const fragment = matches[0].definition as FragmentDefinitionNode; dependencies.set(name, fragment); resolve(fragment, new Set([...ancestors, name]));
    } }); };
    resolve(definition, new Set(definition.kind === "FragmentDefinition" ? [value.name] : []));
    const selections: string[] = [];
    const select = (set: SelectionSetNode, prefix: string, ancestors: Set<string>, depth = 0): void => {
      if (depth > 64 || selections.length > 1000) { if (!problems.some(item => item.code === "SELECTION_LIMIT")) problems.push(issue("SELECTION_LIMIT", "Selected fields exceed the inventory limit.", value.file, value.line)); return; }
      for (const item of set.selections) {
        if (selections.length >= 1000) { if (!problems.some(item => item.code === "SELECTION_LIMIT")) problems.push(issue("SELECTION_LIMIT", "Selected fields exceed the inventory limit.", value.file, value.line)); break; }
        if (item.kind === "Field") { const field = prefix ? `${prefix}.${item.name.value}` : item.name.value; selections.push(field); if (item.selectionSet) select(item.selectionSet, field, ancestors, depth + 1); }
        else if (item.kind === "InlineFragment") select(item.selectionSet, prefix, ancestors, depth + 1);
        else if (!ancestors.has(item.name.value)) { const fragment = dependencies.get(item.name.value); if (fragment) select(fragment.selectionSet, prefix, new Set([...ancestors, item.name.value]), depth + 1); }
      }
    };
    select(definition.selectionSet, "", new Set());
    const evidence = generated.get(value.name);
    let exact = false;
    if (evidence && mappedDefinitions.get(print(definition))?.has(evidence.exportName)) try {
      const typed = new Set(parse(evidence.source).definitions.map(print));
      exact = typed.has(print(definition)) && [...dependencies.values()].every(fragment => typed.has(print(fragment)));
    } catch { /* Invalid generated strings remain Unknown. */ }
    const result: GraphQLDocument = { ...value, fragmentNames: [...dependencies.keys()].sort(), selections: [...new Set(selections)], diagnostics: problems,
      executableSource: value.kind !== "fragment" && !problems.length ? [print(definition), ...[...dependencies.values()].map(print)].join("\n\n") : null,
      generated: evidence && exact ? { status: "available", ...evidence } : { status: evidence ? "unknown" : "missing", exportName: evidence?.exportName ?? null, source: evidence?.source ?? null, hash: evidence?.hash ?? null } };
    diagnostics.push(...problems); return result;
  });
}

/** No application module imports, native evaluator, dependency scan, or runtime reads. */
export function readGraphQLWorkspace(root: string): GraphQLWorkspace {
  root = realpathSync(root);
  const inventory = sourceInventory(root), cached = cache.get(root);
  if (cached?.metadata === inventory.metadata) return cached.value;
  const texts = new Map<string, string | null>(), schemaDiagnostics: WorkspaceDiagnostic[] = [], clientDiagnostics = [...inventory.diagnostics]; let total = 0;
  const read = (name: string, diagnostics: WorkspaceDiagnostic[]): string | null => {
    try { if (total > MAX_TOTAL) throw new Error("GraphQL source exceeds the total inventory limit."); const text = readBounded(root, name); if (text) { total += Buffer.byteLength(text); if (total > MAX_TOTAL) throw new Error("GraphQL source exceeds the total inventory limit."); } texts.set(name, text); return text; }
    catch (error) { diagnostics.push(issue("SOURCE_READ", error instanceof Error ? error.message : "GraphQL source is unavailable.", name)); texts.set(name, null); return null; }
  };
  const schema = schemaInventory(read(SCHEMA, schemaDiagnostics), schemaDiagnostics);
  const tableTypes = tableTypeInventory(schema, inventory.server, name => read(name, []));
  const generated = generatedDocuments(read(GENERATED, clientDiagnostics)), maps = generatedMap(read(GQL_MAP, clientDiagnostics));
  const authored: Authored[] = [], features: GraphQLFeature[] = [];
  for (const name of inventory.names) { const text = read(name, clientDiagnostics); if (text === null) continue; const result = authoredFile(name, text, clientDiagnostics); authored.push(...result.documents); if (result.feature) features.push(result.feature); }
  const documents = completeDocuments(authored, generated, maps, clientDiagnostics);
  const value: GraphQLWorkspace = { revision: digest([...texts]), schema: tableTypes ? { ...schema, tableTypes } : schema, client: { status: !inventory.present ? clientDiagnostics.length ? "invalid" : "missing" : clientDiagnostics.length ? documents.length ? "partial" : "invalid" : "available", documents, features, diagnostics: clientDiagnostics } };
  if (sourceInventory(root).metadata !== inventory.metadata) return { ...value, schema, client: { ...value.client, status: "partial", diagnostics: [...clientDiagnostics, issue("SOURCE_CHANGED", "GraphQL source changed during inspection. Check again.")] } };
  if (cache.size >= 4) cache.delete(cache.keys().next().value!); cache.set(root, { metadata: inventory.metadata, value });
  return value;
}
