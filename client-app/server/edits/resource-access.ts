import path from "node:path";
import ts from "typescript";
import { normalizeResourceAccess, resourceAccessDefinition, resourceAccessKey, type ResourceAccessOptions } from "aws-studio/config/resource-access";
import { locateConfigSource } from "aws-studio/source-index";
import type { DraftEdit } from "../../shared/api";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { declarationObject, hasComments, literalKey, propertyAt, unwrap } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { resourceAlias, addResourceImport } from "./resource-alias";
import { EditError } from "aws-studio/source/io";

type Connection = Extract<DraftEdit, { kind: "connection" }>;
function referencePath(expression: ts.Expression): string[] | undefined {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return [value.text];
  if (ts.isPropertyAccessExpression(value)) { const parent = referencePath(value.expression); return parent && [...parent, value.name.text]; }
  if (ts.isElementAccessExpression(value) && value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression)) { const parent = referencePath(value.expression); return parent && [...parent, value.argumentExpression.text]; }
  return undefined;
}
function literal(expression: ts.Expression): unknown {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(value) && !value.elements.some(ts.isSpreadElement)) return value.elements.map(literal);
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, unknown> = {};
    for (const property of value.properties) {
      const key = literalKey(property);
      if (!ts.isPropertyAssignment(property) || !key || ts.isComputedPropertyName(property.name) || Object.hasOwn(result, key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Use literal access options.");
      result[key] = literal(property.initializer);
    }
    return result;
  }
  throw new Error("Use literal access options.");
}

export function planResourceAccess(root: string, state: StudioState, edit: Connection, overrides: Map<string, string>): void {
  const models = Object.values(state.snapshot.models);
  const target = models.flatMap(model => model.targets).find(item => item.ref === edit.target);
  const resource = models.flatMap(model => model.resources).find(item => item.id === edit.destination);
  const capability = state.snapshot.source.permissionCapabilities?.find(item => item.resource === edit.destination);
  const definition = capability && capability.category === "resource" && resourceAccessDefinition(capability.canonicalTypes);
  if (!target || target.kind === "workflow" || !resource || !/^resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(resource.id) || !definition) throw new EditError(422, "Select a supported native catalog resource and compute workload.");
  if (edit.enabled && capability?.reason) throw new EditError(422, capability.reason);
  let options: ResourceAccessOptions, previous: ResourceAccessOptions | undefined;
  try {
    options = normalizeResourceAccess({ actions: edit.actions!, limits: edit.limits }, definition);
    previous = edit.previous && normalizeResourceAccess(edit.previous, definition);
  } catch (error) { throw new EditError(422, error instanceof Error ? error.message : "Choose supported resource actions."); }
  if (!edit.enabled && previous) throw new EditError(422, "Remove one exact access rule without replacement options.");
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides), parsed = parseOrigin(origin);
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry);
    const declaration = value && parsed && declarationObject(value, parsed.section, parsed.chain);
    if (!entry || !declaration || "unsupported" in declaration) throw new EditError(422, "This computed workload declaration must be edited in source.");
    const file = assertWritable(root, toRelative(root, entry.file)), source = files.get(file);
    let text = files.text(file);
    const position = propertyAt(declaration.object, ["cloud", "bindings"]);
    if (["spread", "unsupported"].includes(position.editability.kind) || position.editability.kind === "computed" && !position.property) throw new EditError(422, "This binding map is computed. Edit it in source.");
    const array = position.property && unwrap(position.property.initializer);
    if (array && (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement) || hasComments(array.getText(source)))) throw new EditError(422, "This binding list is computed or commented. Edit it in source.");
    const { alias, imported } = resourceAlias(root, file, source, text, "stacks", located);
    const names = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "aws-studio/config" || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(`${bindings.name.text}.resourceAccess`);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "resourceAccess") names.add(item.name.text);
    }
    const items = array && ts.isArrayLiteralExpression(array) ? [...array.elements] : [];
    const read = (item: ts.Expression): ResourceAccessOptions | undefined => {
      const call = unwrap(item);
      if (!ts.isCallExpression(call) || !names.has(referencePath(call.expression)?.join(".") ?? "") || call.arguments.length !== 2 || JSON.stringify(referencePath(call.arguments[0]!)) !== JSON.stringify([...alias.split("."), ...resource.path])) return;
      try { return normalizeResourceAccess(literal(call.arguments[1]!) as ResourceAccessOptions, definition); } catch { return; }
    };
    const key = resourceAccessKey(previous ?? options);
    const matches = items.filter(item => { const current = read(item); return current && resourceAccessKey(current) === key; });
    if ((!edit.enabled || previous) && matches.length !== 1) throw new EditError(422, "The exact access rule changed or is ambiguous. Refresh the editor, or edit computed access in source.");
    if (edit.enabled && !previous && matches.length) throw new EditError(422, "This exact access rule already exists.");
    if (previous && items.some(item => !matches.includes(item) && read(item) && resourceAccessKey(read(item)!) === resourceAccessKey(options))) throw new EditError(422, "The replacement access rule already exists.");
    let helper = [...names][0];
    const addHelper = !helper;
    if (!helper) {
      helper = "studioResourceAccess";
      for (let suffix = 2; new RegExp(`\\b${helper}\\b`).test(text); suffix++) helper = `studioResourceAccess${suffix}`;
    }
    const expression = `${helper}(${alias}${resource.path.map(part => `[${JSON.stringify(part)}]`).join("")}, ${JSON.stringify(options)})`;
    if (!array) {
      if (!edit.enabled) throw new EditError(422, "This workload has no access rule to remove.");
      text = insertExpression(text, source, position.container, position.missing, `[${expression}]`);
    } else {
      const retained = items.flatMap(item => matches.includes(item) ? edit.enabled ? [expression] : [] : [item.getText(source)]);
      if (edit.enabled && !previous) retained.push(expression);
      text = text.slice(0, array.getStart(source)) + `[${retained.join(", ")}]` + text.slice(array.end);
    }
    if (edit.enabled && !imported) text = addResourceImport(root, file, text, alias, "stacks", located);
    if (edit.enabled && addHelper) text = `import { resourceAccess as ${helper} } from "aws-studio/config";\n${text}`;
    overrides.set(file, text);
  }
}
