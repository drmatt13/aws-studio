import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { defineNetwork, type InterfaceEndpointService } from "aws-studio/config";
import { readCreationRequest, CreationValidationError, defaultImplementationDirectory, networkCreationProblem, webSocketCreationCondition, type CreationRequest } from "../../shared/creation";
import { DESCRIPTION_FILE } from "../../shared/descriptions";
import { rewriteDescription } from "../descriptions";
import { toRelative } from "../files";
import { insertExpression } from "../resources-source";
import type { StudioState } from "../snapshot";
import { findProperty, hasComments, parse, unwrap, declarationObject, expressionAt, propertyAt, literalKey } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { EditError } from "aws-studio/source/io";
import { readCatalogSource } from "../source/catalog";
import { isCreationGeneratedFile } from "./creation-generation";
import { assertWorkspaceDirectory } from "./workspace";
import type { ScaffoldParameters, ScaffoldSnapshot, ScaffoldTemplateId } from "aws-studio/scaffolding";
import { renderStarter } from "./scaffolding";
import { resourceAlias, addResourceImport } from "./resource-alias";
import { frameworkExport } from "../source/factories";

export interface CreationExpectation { readonly select: string; readonly targets: readonly string[]; readonly resources: readonly string[]; readonly routes: readonly string[]; readonly gateways?: readonly string[]; readonly kind: CreationRequest["kind"]; readonly httpHead?: { readonly route: string; readonly target: string }; readonly network?: { readonly id: string; readonly cidr: string; readonly zones: number; readonly natGateway: boolean; readonly egressOnlyInternetGateway: boolean; readonly gatewayEndpoints: readonly string[]; readonly interfaceEndpoints: readonly string[] } }
export interface CreationSource { readonly overrides: ReadonlyMap<string, string>; readonly before: ReadonlyMap<string, string | null>; readonly expected: CreationExpectation; readonly impact: readonly string[]; readonly templates: readonly ScaffoldSnapshot[] }
const q = JSON.stringify;
function refuse(field: string, message: string): never { throw new CreationValidationError(field, message); }

export function creationCapability(request: CreationRequest): { readonly feature: string; readonly field: string; readonly label: string } | undefined {
  if ((request.kind === "function" || request.kind === "route") && request.head) {
    return { feature: "http-get-with-head", field: "head", label: "Registering HEAD with GET" };
  }
}

/** Fixed creator-owned destinations, with no traversal or symlink components.
 * This authority is used only for a server-generated creation batch. */
export function assertCreationFile(root: string, relative: string): string {
  const allowed = isCreationGeneratedFile(relative) || relative === "framework.config.ts" || /^framework-config\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(relative)
    || /^(?:compute\/(?:http|websocket|events|services|tasks|agents|tools)|archived-workloads\/(?:lambda|service|task|agent))\/(?:[A-Za-z0-9_-]+\/)+(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|py|txt|md)|Dockerfile|\.env\.example)$/.test(relative)
    || /^cdk-app\/lib\/app\/[a-z][a-z0-9-]*-stack\.ts$/.test(relative)
    || relative === "cdk-app/lib/application.ts" || /^cdk-app\/\.env\.(?:dev|prod)\.template$/.test(relative);
  if (!allowed || relative.startsWith("framework-config/templates/") || relative.split("/").some((part) => part === ".." || part === ".") || relative.includes("\\")) throw new EditError(422, "This is not a creator-owned source path.");
  let current = realpathSync(root);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    // lstat detects dangling symlinks too, unlike existsSync.
    try { if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "Creation cannot write through symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path.resolve(root, relative);
}

export function objectCall(file: string, text: string, name: string) {
  const source = parse(file, text);
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (frameworkExport(source, node.expression) === name || ts.isIdentifier(node.expression) && node.expression.text === name)) {
      const argument = node.arguments[0] && unwrap(node.arguments[0]);
      if (argument && ts.isObjectLiteralExpression(argument)) found.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) throw new EditError(422, `Creation requires one literal ${name} declaration in ${file}.`);
  return { source, object: found[0]! };
}
/** Only new modules are printed. Existing authored files always use splices. */
function formatNewModule(file: string, text: string): string {
  const transformed = ts.transform(parse(file, text), [(context) => (source) => {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context);
      if (ts.isPropertyAssignment(visited)) {
        const name = ts.isStringLiteral(visited.name) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(visited.name.text) ? ts.factory.createIdentifier(visited.name.text) : visited.name;
        // Original property ranges can make the printer retain a one-line list
        // even when its new object container is multiline. These nodes belong
        // only to generated source; authored declarations are never reprinted.
        return ts.factory.createPropertyAssignment(name, visited.initializer);
      }
      return ts.isObjectLiteralExpression(visited) ? ts.factory.createObjectLiteralExpression(visited.properties, true) : visited;
    };
    return ts.visitNode(source, visit) as ts.SourceFile;
  }]);
  try {
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed.transformed[0]!)
      .replace(/^( +)/gm, (indent) => " ".repeat(Math.ceil(indent.length / 2)));
  } finally { transformed.dispose(); }
}
function formatNewExpression(file: string, expression: string, text: string, source: ts.SourceFile, container: ts.ObjectLiteralExpression): string {
  const printed = formatNewModule(file, `const declaration = ${expression};\n`);
  const generated = parse(file, printed);
  const value = (generated.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
  const anchor = container.properties.at(-1) ?? container;
  const start = anchor.getStart(source);
  const leading = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
  const containerStart = container.getStart(source);
  const containerIndent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", containerStart - 1) + 1))![0];
  const indent = /^\s*$/.test(leading) && container.properties.length ? leading : `${containerIndent}  `;
  return value.getText(generated).replace(/\n/g, `\n${indent}`);
}
function insertGeneratedEntry(file: string, text: string, source: ts.SourceFile, container: ts.ObjectLiteralExpression, key: string, expression: string): string {
  if (container.properties.length) return insertExpression(text, source, container, [key], formatNewExpression(file, expression, text, source, container));
  if (/\/\*|\/\//.test(container.getText(source))) throw new EditError(422, "This empty section contains authored comments. Add its first entry in source so those comments are preserved deliberately.");
  const printed = formatNewModule(file, `const declaration = { ${q(key)}: ${expression} };\n`);
  const generated = parse(file, printed);
  const value = (generated.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
  const start = container.getStart(source);
  const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", start - 1) + 1))![0];
  return text.slice(0, start) + value.getText(generated).replace(/\n/g, `\n${indent}`) + text.slice(container.end);
}
function addImport(text: string, statement: string, name: string): string {
  const source = parse("imports.ts", text);
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) && node.name && ts.isIdentifier(node.name)) identifiers.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (identifiers.has(name)) throw new EditError(422, `The generated import ${name} conflicts with an existing source identifier.`);
  const previous = source.statements.filter(ts.isImportDeclaration).at(-1);
  if (!previous) return statement + "\n" + text;
  const newline = text.indexOf("\n", previous.end);
  const rest = text.slice(previous.end, newline === -1 ? text.length : newline).trim();
  // Retain a header and any comment attached to the existing import. If the
  // next statement shares its line, split only after the import's semicolon.
  const at = !rest || rest.startsWith("//") || (rest.startsWith("/*") && rest.endsWith("*/")) ? newline === -1 ? text.length : newline + 1 : previous.end;
  const prefix = at === text.length && !text.endsWith("\n") || at === previous.end ? "\n" : "";
  return text.slice(0, at) + prefix + statement + "\n" + text.slice(at);
}

/** Reuse authored import aliases; rename references only in the new declaration. */
function creationImports(file: string, text: string, imports: string, expression: string): { text: string; expression: string } {
  const names = new Map<string, string>();
  const moduleIdentity = (specifier: string) => specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier).replace(/\.(?:js|ts)$/, "").replace(/\/index$/, "") : specifier;
  for (const requested of parse("imports.ts", imports).statements) {
    if (!ts.isImportDeclaration(requested) || !ts.isStringLiteral(requested.moduleSpecifier)) continue;
    const requestedSpecifier = requested.moduleSpecifier.text;
    const bindings = requested.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) throw new EditError(422, "Creation supports named declaration imports only.");
    for (const binding of bindings.elements) {
      const exported = binding.propertyName?.text ?? binding.name.text;
      const source = parse(file, text);
      let alias: string | undefined;
      for (const existing of source.statements) {
        if (!ts.isImportDeclaration(existing) || !ts.isStringLiteral(existing.moduleSpecifier) || moduleIdentity(existing.moduleSpecifier.text) !== moduleIdentity(requestedSpecifier) || existing.importClause?.isTypeOnly) continue;
        const names = existing.importClause?.namedBindings;
        if (names && ts.isNamedImports(names)) alias = names.elements.find(item => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === exported)?.name.text;
        if (alias) break;
      }
      if (!alias) {
        const declared = new Set<string>();
        const visit = (node: ts.Node): void => { if (ts.isIdentifier(node)) declared.add(node.text); ts.forEachChild(node, visit); };
        visit(source);
        alias = exported;
        for (let suffix = 2; declared.has(alias); suffix++) alias = `${exported}${suffix}`;
        const declaration = `${exported}${alias === exported ? "" : ` as ${alias}`}`;
        const compatible = source.statements.find((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && moduleIdentity(statement.moduleSpecifier.text) === moduleIdentity(requestedSpecifier) && !statement.importClause?.isTypeOnly && !!statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && !/\/\*|\/\//.test(statement.importClause.namedBindings.getText(source)));
        const named = compatible?.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          const at = named.elements.at(-1)?.end ?? named.getStart(source) + 1;
          text = text.slice(0, at) + `${named.elements.length ? ", " : " "}${declaration}` + text.slice(at);
        } else text = addImport(text, `import { ${declaration} } from ${q(requestedSpecifier)};`, alias);
      }
      names.set(binding.name.text, alias);
    }
  }
  const prefix = "const declaration = ";
  const source = parse("declaration.ts", `${prefix}${expression};`);
  const edits: { start: number; end: number; value: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && names.get(node.text) !== node.text && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) edits.push({ start: node.getStart(source) - prefix.length, end: node.end - prefix.length, value: names.get(node.text)! });
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const edit of edits.sort((a, b) => b.start - a.start)) expression = expression.slice(0, edit.start) + edit.value + expression.slice(edit.end);
  return { text, expression };
}
export function setProperty(file: string, text: string, object: ts.ObjectLiteralExpression, source: ts.SourceFile, key: string, expression: string): string {
  const found = findProperty(object, key);
  if (found.spread || (found.property && !ts.isPropertyAssignment(found.property))) throw new EditError(422, `Edit computed ${key} in ${file} in your editor first.`);
  if (!found.property) return insertExpression(text, source, object, [key], expression);
  const node = found.property.initializer;
  // A configuration flow may replace literal settings, never custom expressions.
  const literal = (value: ts.Expression): boolean => {
    const item = unwrap(value);
    if (ts.isObjectLiteralExpression(item)) return item.properties.every((property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && literal(property.initializer));
    if (ts.isArrayLiteralExpression(item)) return item.elements.every((element) => ts.isExpression(element) && literal(element));
    return [ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(item.kind);
  };
  if (!literal(node)) throw new EditError(422, `The ${key} setting is computed. Edit it in source.`);
  if (hasComments(node.getText(source))) throw new EditError(422, `The ${key} setting contains source comments. Edit it in source so those comments are preserved deliberately.`);
  return text.slice(0, node.getStart(source)) + expression + text.slice(node.end);
}

export function planCreation(root: string, state: StudioState, raw: CreationRequest): CreationSource {
  const request = readCreationRequest(raw);
  const overrides = new Map<string, string>();
  const before = new Map<string, string | null>();
  const templates: ScaffoldSnapshot[] = [];
  const read = (relative: string) => overrides.get(path.join(root, relative)) ?? readFileSync(path.join(root, relative), "utf8");
  const put = (relative: string, text: string) => {
    const file = assertCreationFile(root, relative);
    if (!before.has(file)) before.set(file, existsSync(file) ? readFileSync(file, "utf8") : null);
    overrides.set(file, text);
  };
  const fresh = (relative: string, text: string) => {
    const file = assertCreationFile(root, relative);
    if (request.implementation === "existing") return;
    if (path.basename(relative) === "package.json") assertWorkspaceDirectory(root, path.dirname(relative));
    if (existsSync(file) || overrides.has(file)) refuse("directory", `The starter file ${relative} already exists. Existing code was preserved. Choose Use existing code or another implementation directory.`);
    put(relative, text);
  };
  const starter = (id: ScaffoldTemplateId, directory: string, options: Partial<ScaffoldParameters> = {}) => {
    if (request.implementation === "existing") return;
    const rendered = renderStarter(root, id, { id: request.id, directory, ...options });
    templates.push(rendered.snapshot);
    for (const [name, text] of rendered.files) fresh(`${directory}/${name}`, text);
  };
  const models = Object.values(state.snapshot.models);
  const targetExists = (id: string) => models.some((model) => model.targets.some((target) => target.id === id));
  const expected: { select: string; targets: string[]; resources: string[]; routes: string[]; gateways?: string[]; kind: CreationRequest["kind"]; httpHead?: CreationExpectation["httpHead"]; network?: CreationExpectation["network"] } = { select: "", targets: [], resources: [], routes: [], kind: request.kind };
  const impact = ["Creates the reviewed source as one reviewed operation. AWS deployment and secret provisioning remain separate actions."];
  const selectedVpc = "vpc" in request && request.vpc ? state.built.located?.networks.find(network => network.id === request.vpc) : undefined;
  if ("vpc" in request && request.vpc && !selectedVpc) return refuse("vpc", "Select a registered VPC with a source declaration.");
  function register(section: string, _id: string, expression: string, imports = "") {
    const relative = `framework-config/workloads/${section.toLowerCase()}.ts`;
    const absolute = path.join(root, relative);
    const types: Record<string, string> = { http: "HttpSection", webSocket: "WebSocketSection", events: "EventsSection", workflows: "WorkflowsSection", services: "ServicesSection", tasks: "TasksSection", agents: "AgentsSection", tools: "ToolsSection", gateways: "GatewaysSection" };
    let rootText = read("framework.config.ts");
    const rootCall = objectCall("framework.config.ts", rootText, "defineFrameworkConfig");
    const rootProperty = findProperty(rootCall.object, section);
    if (rootProperty.spread || (rootProperty.property && !ts.isPropertyAssignment(rootProperty.property))) throw new EditError(422, "Compose workload sections as literal arrays before creating workloads.");
    const array = rootProperty.property && unwrap(rootProperty.property.initializer);
    if (array && (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement))) throw new EditError(422, "Compose workload sections as literal arrays before creating workloads.");
    const composed: { local: string; exported: string }[] = [];
    for (const statement of rootCall.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".") || statement.importClause?.isTypeOnly || path.resolve(root, statement.moduleSpecifier.text.replace(/\.(?:js|ts)$/, "")) !== absolute.replace(/\.ts$/, "")) continue;
      if (!existsSync(absolute) && existsSync(path.join(absolute.replace(/\.ts$/, ""), "index.ts"))) throw new EditError(422, `Creating ${relative} would shadow a composed directory index. Import that existing module with its explicit /index path in framework.config.ts first, so both declarations keep their source ownership.`);
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) if (!binding.isTypeOnly && array && ts.isArrayLiteralExpression(array) && array.elements.some(item => ts.isIdentifier(item) && item.text === binding.name.text)) composed.push({ local: binding.name.text, exported: binding.propertyName?.text ?? binding.name.text });
    }
    if (composed.length > 1) throw new EditError(422, `The canonical ${relative} contributes several section exports. Choose its declaration owner in source before adding a workload here.`);
    const exported = composed[0]?.exported ?? section;
    let text = existsSync(absolute) ? read(relative) : "";
    const existing = text.length > 0;
    if (selectedVpc) {
      const specifier = path.relative(path.dirname(absolute), selectedVpc.file).replaceAll("\\", "/").replace(/\.ts$/, "").replace(/\/index$/, "");
      imports += `import { ${selectedVpc.exportName} as studioVpc } from ${q(specifier.startsWith(".") ? specifier : `./${specifier}`)};\n`;
    }
    if (existing) {
      const merged = creationImports(absolute, text, imports, expression);
      text = merged.text; expression = merged.expression;
      const source = parse(relative, text);
      const declaration = source.statements.filter(ts.isVariableStatement).filter(statement => !!(statement.declarationList.flags & ts.NodeFlags.Const) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).flatMap(statement => [...statement.declarationList.declarations]).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === exported);
      const object = declaration?.initializer && unwrap(declaration.initializer);
      if (!object || !ts.isObjectLiteralExpression(object) || object.properties.some(ts.isSpreadAssignment)) throw new EditError(422, `Creation requires the root-composed ${exported} export in ${relative} to be a literal section object. Keep computed declarations source-owned.`);
      const generated = parse("new-entry.ts", `export const declarations = ${expression};\n`);
      const value = (generated.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer;
      if (!value || !ts.isObjectLiteralExpression(value) || value.properties.length !== 1 || !ts.isPropertyAssignment(value.properties[0]!)) throw new EditError(422, "Creation requires one explicit workload entry.");
      const property = value.properties[0] as ts.PropertyAssignment;
      const key = literalKey(property)!;
      if (findProperty(object, key).property) refuse("id", "This declaration key already exists in the canonical module.");
      text = insertGeneratedEntry(relative, text, source, object, key, property.initializer.getText(generated));
      put(relative, text);
    } else {
      const sectionType = section === "webSocket" ? "Partial<WebSocketSection>" : types[section];
      const merged = creationImports(absolute, "", imports, expression);
      fresh(relative, formatNewModule(relative, `${merged.text}import type { ${types[section]} } from "../workload-types";\n\nexport const ${exported} = ${merged.expression} satisfies ${sectionType};\n`));
    }
    if (composed.length) return;
    const merged = creationImports(path.join(root, "framework.config.ts"), rootText, `import { ${exported} } from ${q("./" + relative.replace(/\.ts$/, ""))};\n`, exported);
    rootText = merged.text;
    const symbol = merged.expression;
    const { source, object } = objectCall("framework.config.ts", rootText, "defineFrameworkConfig");
    const prop = findProperty(object, section).property;
    if (prop && ts.isPropertyAssignment(prop)) {
      const current = unwrap(prop.initializer) as ts.ArrayLiteralExpression;
      const end = current.end - 1;
      rootText = rootText.slice(0, end) + `${current.elements.length && !current.elements.hasTrailingComma ? "," : ""} ${symbol}` + rootText.slice(end);
    } else rootText = insertExpression(rootText, source, object, [section], `[${symbol}]`);
    put("framework.config.ts", rootText);
  }
  function catalog(keys: string[], expression: string, extraImports = "") {
    const catalogName = request.kind === "stack" ? "stacks" : "inputs";
    const catalogFile = `framework-config/${catalogName}/index.ts`;
    let relative = catalogFile;
    let text = read(relative);
    let { source, object } = objectCall(relative, text, catalogName === "stacks" ? "defineStacks" : "defineInputs");
    const key = keys.at(-1)!;
    let existingGroup = false;
    if (keys.length > 1) {
      const group = findProperty(object, keys[0]!);
      if (group.spread) refuse("group", "The catalog group comes from a spread. Make it explicit in source first.");
      if (group.property) {
        existingGroup = true;
        const index = readCatalogSource(root, path.join(root, catalogFile), { start: source.statements.length ? object.parent.getStart(source) : 0, end: object.parent.end }, file => read(path.relative(root, file)));
        const entry = index.get(keys[0]!);
        if (!entry) refuse("group", "This catalog group cannot be located. Edit it in source.");
        relative = entry.value.file;
        text = read(relative); source = parse(relative, text);
        const resolved = expressionAt(source, entry.value.start, entry.value.end);
        if (!resolved || !ts.isObjectLiteralExpression(unwrap(resolved))) refuse("group", "This catalog group is computed. Edit it in source.");
        object = unwrap(resolved) as ts.ObjectLiteralExpression;
      }
    }
    if (object.properties.some(ts.isSpreadAssignment)) refuse("id", "The catalog contains a spread; make this declaration explicit in source first.");
    if ((keys.length === 1 || existingGroup) && findProperty(object, key).property) refuse("id", "This catalog identity already exists.");
    const ensureImports = (file: string, sourceText: string): string => {
      const hasImport = (name: string, specifier: string) => parse(file, sourceText).statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === specifier && !statement.importClause?.isTypeOnly && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(binding => binding.name.text === name && (binding.propertyName?.text ?? binding.name.text) === name && !binding.isTypeOnly));
      const helper = catalogName === "stacks" ? "stack" : "input";
      if (!hasImport(helper, "aws-studio/config")) sourceText = addImport(sourceText, `import { ${helper} } from "aws-studio/config";`, helper);
      if (expression.includes("PROD_DEPLOYMENT") && !hasImport("PROD_DEPLOYMENT", "aws-studio/config/source")) sourceText = addImport(sourceText, 'import { PROD_DEPLOYMENT } from "aws-studio/config/source";', "PROD_DEPLOYMENT");
      return sourceText;
    };
    const symbol = `${keys.join("-").replace(/-([a-zA-Z0-9])/g, (_match, letter: string) => letter.toUpperCase())}`;
    const leaf = keys.join("-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const createdCatalogFile = `framework-config/${catalogName}/${leaf}.ts`;
    if (existsSync(path.join(root, createdCatalogFile)) || overrides.has(path.join(root, createdCatalogFile))) refuse("id", "This declaration file already exists. Choose another identifier.");
    const declarations = ensureImports(createdCatalogFile, extraImports);
    put(createdCatalogFile, formatNewModule(createdCatalogFile, `${declarations}\nexport const ${symbol} = ${expression};\n`));
    const segments = keys.length > 1 && !existingGroup ? keys : [key];
    text = insertExpression(text, source, object, segments, symbol);
    let specifier = path.relative(path.dirname(path.join(root, relative)), path.join(root, createdCatalogFile)).replaceAll("\\", "/").replace(/\.ts$/, "");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    put(relative, addImport(text, `import { ${symbol} } from ${q(specifier)};`, symbol));
  }
  function binding(request: { bindingResource: string; bindingVariable: string }, container: boolean): string {
    if (!request.bindingResource) return "";
    const resource = models.flatMap((model) => model.resources).find((resource) => resource.id === request.bindingResource);
    if (!resource || !["input", "secret"].includes(resource.kind)) return refuse("bindingResource", "Select a declared input parameter or secret.");
    const reference = "inputs" + resource.path.map((part) => `[${q(part)}]`).join("");
    return resource.kind === "secret" ? container
      ? `secrets: { ${q(request.bindingVariable)}: ${reference}.value },`
      : `environment: { ${q(request.bindingVariable)}: ${reference}.arn },`
      : `environment: { ${q(request.bindingVariable)}: ${reference} },`;
  }
  const bindingImport = 'import { inputs } from "../inputs";\n';
  function scopeCatalog(expression: string, scope: "both" | "dev" | "prod"): string {
    return scope === "both" ? expression : `${scope === "dev" ? "!" : ""}PROD_DEPLOYMENT ? ${expression} : undefined`;
  }
  const uniqueTarget = (id: string) => { if (targetExists(id)) refuse("id", "This workload identifier is already declared."); };
  if (request.kind === "input" || request.kind === "secret") {
    const keys = [...(request.group ? [request.group] : []), request.id];
    const linkedToEnv = request.kind === "secret" || request.linkedToEnv !== false;
    if (linkedToEnv && models.some((model) => model.resources.some((resource) => resource.fromEnv === request.envName))) refuse("envName", "This environment variable is already declared in the catalog.");
    const metadata = Object.keys(request.tags ?? {}).length ? `, { tags: ${q(request.tags)} }` : "";
    let expression = !linkedToEnv && request.kind === "input" ? `input.value(${q(request.value ?? "")}${metadata})`
      : `input.${request.kind === "secret" ? "secret" : "fromEnv"}(${q(request.envName)}${metadata})`;
    if (linkedToEnv && request.required) expression += ".required()";
    if (request.kind === "input") {
      if (request.choices.length) expression += `.enum(${request.choices.map((choice) => q(choice)).join(", ")})`;
      if (linkedToEnv && request.defaultValue) expression += `.default(${q(request.defaultValue)})`;
    }
    catalog(keys, expression);
    expected.select = `resource:${keys.join(".")}`; expected.resources.push(expected.select);
    if (request.consumer) {
      const target = models.flatMap((model) => model.targets).find((target) => target.ref === request.consumer);
      const origin = target?.origins[0] && parseOrigin(target.origins[0]);
      const located = origin && origin.section !== "defaults" && state.built.located?.sections[origin.section].find((entry) => entry.key === origin.key);
      if (!target || !located || !origin) refuse("consumer", "Select an existing workload with an explicit section declaration.");
      const relative = toRelative(root, located.file);
      let text = read(relative);
      const source = parse(relative, text);
      const value = expressionAt(source, located.valueSpan.start, located.valueSpan.end);
      const declaration = value && declarationObject(value, origin.section, origin.chain);
      if (!declaration || "unsupported" in declaration) refuse("consumer", "This consumer is computed. Bind it in source.");
      const container = target.kind === "service" || target.kind === "task";
      const property = container && request.kind === "secret" ? "secrets" : "environment";
      const position = propertyAt(declaration.object, [property, request.consumerVariable]);
      if (position.property || !["absent"].includes(position.editability.kind)) refuse("consumerVariable", "This environment variable already exists or comes from a computed mapping.");
      const { alias, imported } = resourceAlias(root, located.file, source, text, "inputs");
      const reference = `${alias}${keys.map((key) => `[${q(key)}]`).join("")}${request.kind === "secret" ? container ? ".value" : ".arn" : ""}`;
      text = insertExpression(text, source, position.container, position.missing, reference);
      put(relative, imported ? text : addResourceImport(root, located.file, text, alias, "inputs"));
      impact.push(`Connects ${expected.select} to ${target.ref} as ${request.consumerVariable}, using the framework's resource delivery and permission resolution.`);
    }
    for (const mode of linkedToEnv ? ["dev", "prod"] : []) {
      const file = `cdk-app/.env.${mode}.template`;
      if (existsSync(path.join(root, file)) && !new RegExp(`^\\s*(?:#\\s*)?${request.envName}\\s*=`, "m").test(read(file))) put(file, read(file).replace(/\s*$/, "\n") + `# ${request.envName}=\n`);
    }
    impact.push(linkedToEnv
      ? "Adds the catalog declaration and commented template keys. Authored environment files are never written. Inputs are strings; secret values are accepted only by the separate protected input lifecycle."
      : "Adds the input's value in its source declaration. Environment files and templates are unchanged.");
  } else if (request.kind === "function" || request.kind === "route") {
    const section = request.category === "event" ? "events" : request.category === "http" ? "http" : "webSocket";
    const routeId = request.category === "http" ? `route:http:${request.path}` : `route:ws:${request.path}`;
    if (request.category !== "event" && models.some(model => model.routes.some(route => route.id === routeId))) {
      return refuse("path", `The route ${request.path} already exists. Review its declaration to change the registered methods.`);
    }
    if (request.head) impact.push("Registers GET and HEAD with the same handler and authorization in local development and API Gateway.");
    let declaration: string;
    let target = `lambda:${request.id}`;
    if (request.kind === "route" && request.existingTarget) {
      const existing = models[0]!.targets.find((target) => target.ref === request.existingTarget && target.role === request.category);
      if (!existing) return refuse("existingTarget", "Choose a routed Lambda of the same category.");
      if (Object.keys(request.tags ?? {}).length && JSON.stringify(request.tags) !== JSON.stringify(models[0]!.tagging?.[existing.ref]?.authored ?? {})) return refuse("tags", "Routes sharing a function share its tags. Edit the existing function tags, then add this route.");
      const location = state.snapshot.source.entities[existing.ref]?.value;
      if (!location) throw new EditError(422, "The existing function's declaration could not be located.");
      const text = read(location.file);
      declaration = text.slice(location.start, location.end);
      const wrapper = `const entry = ${declaration};`;
      const parsed = parse("entry.ts", wrapper);
      const node = unwrap(parsed.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!.initializer!);
      if (!ts.isObjectLiteralExpression(node) || node.properties.some(ts.isSpreadAssignment)) throw new EditError(422, "Reuse requires an explicit routed Lambda declaration.");
      if (request.category === "http") {
        const methods = setProperty("entry.ts", wrapper, node, parsed, "methods", request.method === "*" ? q("*") : `[${q(request.method)}]`);
        const next = parse("entry.ts", methods);
        const entry = unwrap(next.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!.initializer!) as ts.ObjectLiteralExpression;
        const withHead = request.head || findProperty(entry, "head").property
          ? setProperty("entry.ts", methods, entry, next, "head", request.head ? "true" : "false")
          : methods;
        const final = parse("entry.ts", withHead);
        declaration = final.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!.initializer!.getText(final);
      }
      const source = parse(location.file, text);
      const value = expressionAt(source, location.start, location.end);
      const owner = value?.parent;
      const sectionObject = owner && ts.isPropertyAssignment(owner) ? owner.parent : undefined;
      if (!sectionObject || !ts.isObjectLiteralExpression(sectionObject) || sectionObject.properties.some(ts.isSpreadAssignment)) throw new EditError(422, "Reuse requires a literal section object, so its existing imports and local references can be preserved.");
      if (findProperty(sectionObject, request.path).property) return refuse("path", "This route key is already declared. Edit its methods in the existing declaration.");
      put(location.file, insertGeneratedEntry(location.file, text, source, sectionObject, request.path, declaration));
      target = existing.ref;
      impact.push("The new route reuses the existing function's authentication and all target settings; its construct identity and handler are preserved.");
    } else {
      uniqueTarget(request.id);
      let deploy = q(request.deploy);
      let conditionalDeploy = false;
      if (request.category === "webSocket" && request.deploy !== "none") {
        const condition = webSocketCreationCondition(models);
        if (condition) {
          if (request.deploy !== "both") return refuse("deploy", "This WebSocket handler must use the $connect condition. Choose Use $connect condition or Off.");
          const selector = models[0]!.resources.find(resource => resource.id === condition.resource);
          if (!selector || selector.kind !== "input" || (!selector.fromEnv && selector.authoredValue === undefined) || models.some(model => !model.resources.some(resource => resource.id === selector.id && !resource.absent))) return refuse("deploy", "The $connect condition needs an input parameter declared in both environments. Configure the handler in source, or choose Off.");
          deploy = `{ when: { resource: inputs${selector.path.map(part => `[${q(part)}]`).join("")}, equals: ${q(condition.equals)} } }`;
          conditionalDeploy = true;
          impact.push(`Copies $connect deployment condition: ${selector.fromEnv ?? selector.path.join(".")} equals ${q(condition.equals)}. Each environment resolves its own input value.`);
        }
      }
      const directory = request.directory || defaultImplementationDirectory(request.kind, request.id, request.category)!;
      if (request.head && request.implementation === "existing") {
        const handler = assertCreationFile(root, `${directory}/index.ts`);
        if (!existsSync(handler) || !lstatSync(handler).isFile()) {
          return refuse("directory", `Use an existing TypeScript handler at ${toRelative(root, handler)} or choose Create starter files.`);
        }
        impact.push(`Reuses the developer-owned handler at ${toRelative(root, handler)}.`);
      }
      const auth = request.category === "http" && request.auth;
      const replay = request.category === "event" && request.localReplay;
      starter(request.category === "http" ? auth ? "lambda/http-authenticated" : "lambda/http" : request.category === "webSocket" ? "lambda/websocket" : replay ? "lambda/event" : "lambda/event-result", directory);
      declaration = `{ tags: ${q(request.tags ?? {})}, directory: ${q(directory)}, ${request.category !== "event" ? `id: ${q(request.id)},` : ""} deploy: ${deploy}, runtime: ${q(request.runtime)}, packaging: "zip", architecture: ${q(request.architecture)}, memorySize: ${request.memory}, timeoutSeconds: ${request.timeout}, ${replay ? "localReplay: true," : ""} subnet: ${q(request.subnet)}, ${selectedVpc ? "vpc: studioVpc," : ""} ${request.category === "http" ? `methods: ${request.method === "*" ? q("*") : `[${q(request.method)}]`}, ${request.head ? "head: true," : ""} ${auth ? "auth: true, userPool: true," : ""}` : ""} ${binding(request, false)} }`;
      register(section, request.id, `{ ${q(request.category === "event" ? request.id : request.path)}: ${declaration} }`, request.bindingResource || conditionalDeploy ? bindingImport : "");
      expected.targets.push(target);
      impact.push(`Handler: ${directory}/index.ts. TypeScript zip packaging; other runtimes and images remain source-authored.`);
    }
    if (request.category !== "event") expected.routes.push(routeId);
    if (request.head) expected.httpHead = { route: routeId, target };
    expected.select = request.kind === "route" ? routeId : target;
  } else if (request.kind === "task" || request.kind === "service") {
    uniqueTarget(request.id);
    const service = request.kind === "service";
    const directory = request.directory || defaultImplementationDirectory(request.kind, request.id)!;
    starter(service ? "container-service" : "container-task", directory, { port: service ? request.port : undefined });
    register(service ? "services" : "tasks", request.id, `{ ${q(service ? request.path : request.id)}: { tags: ${q(request.tags ?? {})}, directory: ${q(directory)}, ${service ? `id: ${q(request.id)}, methods: "*", port: ${request.port}, healthCheckPath: "/health", ${request.auth ? "auth: true," : ""}` : ""} deploy: ${q(request.deploy)}, ${binding(request, true)} cloud: { vpc: studioVpc, cpu: ${request.cpu}, memoryMiB: ${request.memory}, architecture: ${q(request.architecture)}, subnet: ${q(request.subnet)} } } }`, request.bindingResource ? bindingImport : "");
    expected.select = `${request.kind}:${request.id}`; expected.targets.push(expected.select);
    if (service) expected.routes.push(`route:service:${request.path}`);
    if (service) impact.push("The new workspace requires rebuilding local development images with dev:containers. Source creation does not start containers.");
    impact.push("The Docker build context is the repository root. Images use the framework's existing build, labeling and reconciliation paths. The reviewed operation includes the generated local Compose projection.");
  } else if (request.kind === "workflow") {
    uniqueTarget(request.id);
    const calls = request.steps.map((ref, index) => {
      const target = models[0]!.targets.find((target) => target.ref === ref && (target.kind === "task" || target.role === "event"));
      if (!target) return refuse("steps", "Initial steps must name existing event Lambdas or container tasks.");
      return `const step${index} = ${target.kind === "task" ? "runTask" : "invokeLambda"}(${q(target.id)}, { payload: ${index ? `step${index - 1}.output` : "input"} });`;
    });
    const result = request.steps.length ? `step${request.steps.length - 1}.output` : "input";
    register("workflows", request.id, `{ ${q(request.id)}: workflow<Record<string, unknown>>(({ input }) => {\n    ${calls.join("\n    ")}\n    return ${calls.length ? `sequence(${calls.map((_call, index) => `step${index}`).join(", ")}, succeed(${result}))` : "succeed(input)"};\n  }, { tags: ${q(request.tags ?? {})}, deploy: ${q(request.deploy)}, timeoutSeconds: ${request.timeout} }) }`, 'import { workflow, succeed, sequence, invokeLambda, runTask } from "aws-studio/config";\n');
    expected.select = `workflow:${request.id}`; expected.targets.push(expected.select);
  } else if (request.kind === "agent") {
    uniqueTarget(request.id);
    const directory = (request.directory || defaultImplementationDirectory("agent", request.id)!).replace(/^\//, "");
    const modelStarter = request.starter === "model";
    for (const id of request.gateways) if (!models.every(model => model.gateways?.some(gateway => gateway.protocol === "agentcore" && gateway.key === id))) refuse("gateways", "Choose existing AgentCore gateways.");
    starter(modelStarter ? "agent/model" : "agent/respond", directory);
    const extra = binding(request, false);
    const extraEnv = extra ? extra.replace(/^environment: \{ /, "").replace(/ \},$/, "") : "";
    register("agents", request.id, `{ ${q(request.id)}: { tags: ${q(request.tags ?? {})}, directory: ${q(directory)}, deploy: ${q(request.deploy)}, ${request.auth ? "auth: true," : ""} ${request.path ? `route: ${q(request.path)},` : ""} gateways: ${q(request.gateways)}, environment: { ${modelStarter ? "...modelProviders.environment," : ""} ${extraEnv} }, ${modelStarter ? "cloud: { access: modelProviders.access, requirements: modelProviders.requirements }" : ""} } }`, (modelStarter ? 'import { modelProviders } from "../model-providers";\n' : '') + (request.bindingResource ? bindingImport : ""));
    expected.select = `agent:${request.id}`; expected.targets.push(expected.select);
    impact.push(modelStarter ? "Uses @repo/models shared provider selection, secrets and IAM. Model calls incur provider charges." : "Echo returns the message without calling a model or requiring model provider inputs.", "Adds a workspace with declared dependencies and a TypeScript check. Rebuild local development images for the new workspace before invoking it locally.");
  } else if (request.kind === "gateway") {
    const id = `gateway:agentcore:${request.id}`;
    if (models.some(model => model.gateways?.some(gateway => gateway.id === id))) refuse("id", "This Gateway identifier already exists.");
    for (const tool of request.tools) if (!models.every(model => model.targets.some(target => target.role === "tool" && target.id === tool))) refuse("tools", "Choose existing Lambda tool identifiers.");
    register("gateways", request.id, `{ ${q(request.id)}: { tags: ${q(request.tags ?? {})}, tools: ${q(request.tools)}, deploy: ${q(request.deploy)} } }`);
    expected.select = id; expected.gateways = [id];
    impact.push("The Gateway owns its selected Lambda targets. Agents select it through gateways; IAM invocation grants and runtime connection metadata are derived automatically. No authored environment values are written.");
  } else if (request.kind === "tool") {
    uniqueTarget(request.id);
    const directory = request.directory || defaultImplementationDirectory("tool", request.id)!;
    starter(request.auth ? "tool/authenticated" : "tool/public", directory);
    register("tools", request.id, `{ ${q(request.id)}: { tags: ${q(request.tags ?? {})}, directory: ${q(directory)}, ${request.deploy !== "inherit" ? `deploy: ${q(request.deploy)},` : ""} ${request.auth ? "auth: true," : ""} ${binding(request, false)} } }`, request.bindingResource ? bindingImport : "");
    expected.select = `lambda:${request.id}`; expected.targets.push(expected.select);
    impact.push("A tool follows the gateways that declare it. Add this tool to a gateway to enable execution; creation neither invokes a model nor deploys a Gateway.");
  } else if (request.kind === "auth-provider") {
    const relative = "framework-config/auth/additional-providers.ts";
    let text = read(relative);
    const source = parse(relative, text);
    const declaration = source.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []).find(node => ts.isIdentifier(node.name) && node.name.text === "additionalAuthProviders");
    const array = declaration?.initializer && unwrap(declaration.initializer);
    if (!array || !ts.isArrayLiteralExpression(array) || array.elements.some(element => !ts.isObjectLiteralExpression(unwrap(element)))) throw new EditError(422, "Compose additionalAuthProviders as a literal array of provider objects before using this creator.");
    for (const element of array.elements) {
      const object = unwrap(element) as ts.ObjectLiteralExpression;
      for (const [field, value] of [["id", request.id], ["name", request.providerName]]) {
        const property = findProperty(object, field).property;
        if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(unwrap(property.initializer))) throw new EditError(422, "Provider IDs and names must be literal source values before another provider can be added.");
        if ((unwrap(property.initializer) as ts.StringLiteralLike).text === value) return refuse(field === "id" ? "id" : "providerName", "This authentication provider identifier/name already exists. Existing source was preserved.");
      }
    }
    let secretReference = "";
    if (request.providerType === "oidc") {
      const existing = models.flatMap(model => model.resources).find(resource => resource.kind === "secret" && resource.fromEnv === request.secretEnvName);
      if (existing) {
        if (!existing.path.length || existing.path.some(segment => !/^[A-Za-z_$][\w$]*$/.test(segment))) throw new EditError(422, "The existing secret reference has a custom catalog path. Configure this provider in source.");
        secretReference = `inputs.${existing.path.join(".")}`;
      } else {
        const secretId = `${request.id.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())}ClientSecret`;
        catalog([secretId], `input.secret(${q(request.secretEnvName)}, { tags: ${q(request.tags ?? {})} })`);
        secretReference = `inputs.${secretId}`;
        expected.resources.push(`resource:${secretId}`);
      }
    }
    const attributes = { email: request.emailAttribute, givenName: request.givenNameAttribute, familyName: request.familyNameAttribute, emailVerified: request.emailVerifiedAttribute };
    const expression = `{ id: ${q(request.id)}, name: ${q(request.providerName)}, scope: ${q(request.scope)}, type: ${q(request.providerType)}, attributes: ${q(attributes)}, ${request.providerType === "oidc" ? `issuer: ${q(request.issuer)}, clientId: ${q(request.clientId)}, scopes: ${q(request.scopes)}, clientSecret: ${secretReference}` : `metadataUrl: ${q(request.metadataUrl)}`} }`;
    text = text.slice(0, array.end - 1) + `${array.elements.length && !array.elements.hasTrailingComma ? "," : ""}\n  ${expression},\n` + text.slice(array.end - 1);
    const hasResources = source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "../inputs" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(binding => binding.name.text === "inputs" && !binding.isTypeOnly));
    if (secretReference && !hasResources) text = addImport(text, 'import { inputs } from "../inputs";', "inputs");
    put(relative, text);
    expected.select = expected.resources[0] ?? "resource:cognito";
    impact.push(`Adds ${request.providerType.toUpperCase()} provider ${request.providerName} to the application's existing Cognito stack/client in ${request.scope} graphs. Existing Google, pool and client construct identities are preserved.`, request.providerType === "oidc" ? `Client secret comes only from the declared ${request.secretEnvName} resource. Author its value in the selected CDK inputs and provision separately. No secret value enters source or this proposal. Confirm client_secret_post, issuer discovery, scopes and the /oauth2/idpresponse redirect with the provider.` : "The SAML metadata URL is authored in source. Configure the provider's SP entity ID urn:amazon:cognito:sp:<pool-id> and ACS https://<cognito-domain>/saml2/idpresponse separately. IdP-initiated sign-in and SAML sign-out are disabled.", "Attribute mappings include a separately reviewed verified-email claim. Provider metadata or a configured secret does not prove external provider acceptance or successful sign-in.");
  } else if (request.kind === "stack") {
    const classFile = request.className.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const file = `cdk-app/lib/app/${classFile}.ts`;
    catalog([request.id], scopeCatalog(`stack<${request.className}>({ tags: ${q(request.tags ?? {})} })`, request.scope), `import type { ${request.className} } from ${q(`../../cdk-app/lib/app/${classFile}`)};\n`);
    const bucket = request.template === "bucket";
    const identityPool = request.template === "identity-pool";
    const member = bucket ? "bucket" : "queue", construct = bucket ? "Bucket" : "Queue", output = bucket ? "BucketName" : "QueueUrl";
    fresh(file, identityPool ? `import { Stack, type StackProps, CfnOutput } from "aws-cdk-lib";\nimport type { CfnIdentityPool, CfnUserPoolGroup, IUserPool, IUserPoolClient } from "aws-cdk-lib/aws-cognito";\nimport type { Role } from "aws-cdk-lib/aws-iam";\nimport type { Construct } from "constructs";\nimport { identityPoolAccess } from "./identity-pool-access";\nimport { linkResources } from "aws-studio/cdk/framework-resources";\nimport { stacks } from "../../../framework-config/stacks";\n\ninterface Props extends StackProps { readonly userPool: IUserPool; readonly userPoolClient: IUserPoolClient }\nexport class ${request.className} extends Stack {\n  public readonly identityPool: CfnIdentityPool;\n  public readonly authenticatedRole: Role;\n  public readonly readerRole: Role;\n  public readonly readerGroup: CfnUserPoolGroup;\n  public readonly identityPoolId: string;\n\n  constructor(scope: Construct, id: string, props: Props) {\n    super(scope, id, props);\n    const access = identityPoolAccess(this, { userPool: props.userPool, userPoolClient: props.userPoolClient, groupName: ${q(`${request.id}-reader`)},${request.readBucketArn ? ` readBucketArn: ${q(request.readBucketArn)}, readPrefix: ${q(request.readPrefix ?? "")},` : ""} });\n    this.identityPool = access.identityPool;\n    this.authenticatedRole = access.authenticatedRole;\n    this.readerRole = access.readerRole;\n    this.readerGroup = access.readerGroup;\n    this.identityPoolId = this.identityPool.ref;\n    new CfnOutput(this, "IdentityPoolId", { value: this.identityPoolId, exportName: this.stackName + ":IdentityPoolId" });\n    new CfnOutput(this, "AuthenticatedRoleArn", { value: this.authenticatedRole.roleArn, exportName: this.stackName + ":AuthenticatedRoleArn" });\n    new CfnOutput(this, "ReaderRoleArn", { value: this.readerRole.roleArn, exportName: this.stackName + ":ReaderRoleArn" });\n    linkResources(this, stacks.${request.id});\n  }\n}\n` : `import { Stack, type StackProps, CfnOutput${bucket ? ", RemovalPolicy" : ""} } from "aws-cdk-lib";\n${bucket ? 'import { Bucket, BucketEncryption, BlockPublicAccess } from "aws-cdk-lib/aws-s3";' : 'import { Queue } from "aws-cdk-lib/aws-sqs";'}\nimport type { Construct } from "constructs";\nimport { linkResources } from "aws-studio/cdk/framework-resources";\nimport { stacks } from "../../../framework-config/stacks";\n\nexport class ${request.className} extends Stack {\n  public readonly ${member}: ${construct};\n\n  constructor(scope: Construct, id: string, props?: StackProps) {\n    super(scope, id, props);\n    this.${member} = new ${construct}(this, "${construct}", { enforceSSL: true${bucket ? ", encryption: BucketEncryption.S3_MANAGED, blockPublicAccess: BlockPublicAccess.BLOCK_ALL, removalPolicy: RemovalPolicy.RETAIN, autoDeleteObjects: false" : ""} });\n    new CfnOutput(this, "${output}", { value: this.${member}.${bucket ? "bucketName" : "queueUrl"}, exportName: this.stackName + ":${output}" });\n    linkResources(this, stacks.${request.id});\n  }\n}\n`);
    let app = read("cdk-app/lib/application.ts");
    const source = parse("cdk-app/lib/application.ts", app);
    const application = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "configureApplication");
    const statements = application?.body?.statements;
    if (!statements) throw new EditError(422, "Cannot locate the configureApplication function body.");
    const orchestration = statements.find((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((node) => ts.isIdentifier(node.name) && node.name.text === "orchestration"));
    if (!orchestration) throw new EditError(422, "Cannot locate the application stack registration point before orchestration.");
    const at = orchestration.getFullStart();
    if (identityPool && !statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(node => ts.isIdentifier(node.name) && node.name.text === "cognitoStack"))) throw new EditError(422, "The identity-pool template requires the application's cognitoStack registration. Keep custom authentication composition in native source.");
    const registration = `\n  ${request.scope !== "both" ? `if (mode === ${q(request.scope)}) {\n    ` : ""}new ${request.className}(app, stackId(${q(request.className)}), { env: stackEnv${identityPool ? ", userPool: cognitoStack.userPool, userPoolClient: cognitoStack.userPoolClient" : ""} });${request.scope !== "both" ? "\n  }" : ""}\n`;
    app = app.slice(0, at) + registration + app.slice(at);
    put("cdk-app/lib/application.ts", addImport(app, `import { ${request.className} } from ${q(`./app/${classFile}`)};`, request.className));
    expected.select = `resource:${request.id}`; expected.resources.push(expected.select);
    impact.push(`Instantiates ${request.className} in ${request.scope} deployment graphs, before orchestration, and exposes its typed ${identityPool ? "identity pool and authenticated role" : member} through linkResources. The stack identity is deployment-prefixed.`);
    if (identityPool) impact.push(`Connects the application's user pool/client. Guest and classic auth flows are disabled. Web-identity trust is constrained to this pool's aud and authenticated amr. Token role mapping denies ambiguity; the ${request.id}-reader group has precedence 10. Group membership is a separate authorized operation.`, request.readBucketArn ? `The default authenticated role remains permissionless. The reader-group role grants s3:GetObject only on ${request.readBucketArn}/${request.readPrefix ?? ""}*. No writes or listing are granted.` : "No AWS API permissions are granted to the role by default. Author narrow policies in this native source before using AWS resources.", "These source declarations do not prove successful credential issuance, group claims or effective IAM behavior; synth/diff and authorized runtime tests are separate.");
  } else {
    const problem = networkCreationProblem(request, models.flatMap(model => model.networks ?? []));
    if (problem) throw problem;
    let declared;
    try { declared = defineNetwork({ id: request.id, cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, gatewayEndpoints: { s3: request.s3, dynamodb: request.dynamodb }, interfaceEndpoints: request.endpoints as InterfaceEndpointService[] }); }
    catch (error) { return refuse(/endpoint/i.test(String(error)) ? "endpoints" : "cidr", error instanceof Error ? error.message : String(error)); }
    if (models.some(model => model.networks?.some(network => network.id === request.id || network.constructId === declared.cloud.constructId))) return refuse("id", "This VPC identity or deployed construct identity already exists.");
    const file = `framework-config/networks/${request.id}.ts`;
    const symbol = `${request.id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}Vpc`;
    fresh(file, formatNewModule(file, `import { defineNetwork } from "aws-studio/config";\nexport const ${symbol} = defineNetwork(${JSON.stringify({ id: request.id, tags: request.tags ?? {}, ...(request.name ? { name: request.name } : {}), cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, gatewayEndpoints: { s3: request.s3, dynamodb: request.dynamodb }, interfaceEndpoints: request.endpoints })});\n`));
    let text = read("framework.config.ts");
    const { source, object } = objectCall("framework.config.ts", text, "defineFrameworkConfig");
    const property = findProperty(object, "networks");
    if (property.spread || (property.property && !ts.isPropertyAssignment(property.property))) throw new EditError(422, "Compose networks as a literal array.");
    if (property.property && ts.isPropertyAssignment(property.property)) {
      const array = unwrap(property.property.initializer);
      if (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement)) throw new EditError(422, "Compose networks as a literal array.");
      text = text.slice(0, array.end - 1) + `${array.elements.length && !array.elements.hasTrailingComma ? "," : ""} ${symbol}` + text.slice(array.end - 1);
    } else text = insertExpression(text, source, object, ["networks"], `[${symbol}]`);
    put("framework.config.ts", addImport(text, `import { ${symbol} } from ${q(`./framework-config/networks/${request.id}`)};`, symbol));
    expected.select = `island:vpc:${request.id}`;
    expected.network = { id: request.id, cidr: request.cidr, zones: request.zones, natGateway: request.nat, egressOnlyInternetGateway: request.ipv6, gatewayEndpoints: [...(request.s3 ? ["s3"] : []), ...(request.dynamodb ? ["dynamodb"] : [])], interfaceEndpoints: request.endpoints };
    impact.push("Creates a separate VPC declaration. It appears as a blueprint until production infrastructure uses it.", `Cost-relevant settings: NAT ${request.nat ? "enabled (hourly plus data processing)" : "off"}; ${request.endpoints.length} interface endpoints in ${request.zones} zones (hourly plus data processing).`);
  }
  if (request.description) {
    const text = existsSync(path.join(root, DESCRIPTION_FILE)) ? read(DESCRIPTION_FILE) : "export const descriptions = {};\n";
    put(DESCRIPTION_FILE, rewriteDescription(text, expected.select, request.description));
  }
  for (const [file, text] of overrides) {
    if (!file.endsWith(".ts")) continue;
    const diagnostics = ts.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics ?? [];
    if (diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) throw new EditError(422, `Generated source does not parse in ${toRelative(root, file)}.`);
  }
  return { overrides, before, expected, impact, templates };
}
