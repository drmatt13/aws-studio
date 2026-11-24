import path from "node:path";
import ts from "typescript";
import { assertJsonArguments, type JsonArgument } from "aws-studio/config/cdk-resources";
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
function literal(expression: ts.Expression): JsonArgument {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) return -Number(value.operand.text);
  if (ts.isArrayLiteralExpression(value) && !value.elements.some(ts.isSpreadElement)) return value.elements.map(literal);
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, JsonArgument> = {};
    for (const property of value.properties) {
      const key = literalKey(property);
      if (!ts.isPropertyAssignment(property) || !key || ts.isComputedPropertyName(property.name) || Object.hasOwn(result, key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Use literal JSON arguments.");
      result[key] = literal(property.initializer);
    }
    return result;
  }
  throw new Error("Use literal JSON arguments.");
}
function identity(method: string, args: readonly JsonArgument[]): string {
  const stable = (value: JsonArgument): JsonArgument => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify([method, args.map(stable)]);
}

/** Edit exactly one declared native grant or managed-policy attachment. Readiness is separate. */
export function planNativeBinding(root: string, state: StudioState, edit: Connection, overrides: Map<string, string>): void {
  const models = Object.values(state.snapshot.models);
  const target = models.flatMap(model => model.targets).find(item => item.ref === edit.target);
  const resource = models.flatMap(model => model.resources).find(item => item.id === edit.destination);
  const capability = state.snapshot.source.permissionCapabilities?.find(item => item.resource === edit.destination);
  const managed = edit.connection === "managedPolicy";
  if (!target || target.kind === "workflow" || !resource || !/^resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(resource.id) || !capability) throw new EditError(422, "Select a public native catalog resource and compute workload.");
  if (edit.enabled && capability.reason) throw new EditError(422, capability.reason);
  if (managed && capability.category !== "policy") throw new EditError(422, "Select a public native IManagedPolicy field.");
  if (managed && edit.previousGrant) throw new EditError(422, "Managed policies are attached or removed by their catalog reference.");
  const args = edit.grantArguments ?? (edit.scope ? [edit.scope] : []);
  const previous = edit.previousGrant;
  if (previous && !edit.enabled) throw new EditError(422, "Remove one exact native grant without replacement arguments.");
  if (!managed) {
    const discovered = capability.grants ?? [];
    const method = discovered.find(item => item.method === edit.grant);
    if (!method || "reason" in method && method.reason) throw new EditError(422, method && "reason" in method ? String(method.reason) : "Choose a discovered grant with serializable arguments.");
    try { assertJsonArguments(args, method.method); if (previous) assertJsonArguments(previous.arguments, previous.method); } catch (error) { throw new EditError(422, (error as Error).message); }
    const required = method.parameters.filter(parameter => !parameter.optional && !("rest" in parameter && parameter.rest)).length;
    if (args.length < required || !method.parameters.some(parameter => "rest" in parameter && parameter.rest) && args.length > method.parameters.length) throw new EditError(422, "Supply the arguments shown by the discovered CDK signature.");
  }
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
      if (bindings && ts.isNamespaceImport(bindings)) names.add(`${bindings.name.text}.managedPolicy`);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "managedPolicy") names.add(item.name.text);
    }
    const expectedPath = JSON.stringify([...alias.split("."), ...resource.path]);
    const read = (item: ts.Expression): string | undefined => {
      const call = unwrap(item);
      if (!ts.isCallExpression(call)) return;
      if (managed) return names.has(referencePath(call.expression)?.join(".") ?? "") && call.arguments.length === 1 && JSON.stringify(referencePath(call.arguments[0]!)) === expectedPath ? "managedPolicy" : undefined;
      if (!ts.isPropertyAccessExpression(call.expression) || JSON.stringify(referencePath(call.expression.expression)) !== expectedPath) return;
      try { return identity(call.expression.name.text, call.arguments.map(literal)); } catch { return; }
    };
    const items = array && ts.isArrayLiteralExpression(array) ? [...array.elements] : [];
    const key = managed ? "managedPolicy" : identity(previous?.method ?? edit.grant!, previous?.arguments ?? args);
    const matches = items.filter(item => read(item) === key);
    if ((!edit.enabled || previous) && matches.length !== 1) throw new EditError(422, "The exact permission changed or is ambiguous. Refresh the editor, or open its declaration.");
    if (edit.enabled && !previous && matches.length) throw new EditError(422, "This exact permission already exists.");
    if (previous && items.some(item => !matches.includes(item) && read(item) === identity(edit.grant!, args))) throw new EditError(422, "The replacement native grant already exists.");
    let helper = [...names][0];
    const addHelper = managed && !helper;
    if (!helper) { helper = "studioManagedPolicy"; for (let suffix = 2; new RegExp(`\\b${helper}\\b`).test(text); suffix++) helper = `studioManagedPolicy${suffix}`; }
    const reference = `${alias}${resource.path.map(part => `[${JSON.stringify(part)}]`).join("")}`;
    const expression = managed ? `${helper}(${reference})` : `${reference}.${edit.grant}(${args.map(arg => JSON.stringify(arg)).join(", ")})`;
    if (!array) {
      if (!edit.enabled) throw new EditError(422, "This workload has no native binding to remove.");
      text = insertExpression(text, source, position.container, position.missing, `[${expression}]`);
    } else {
      const retained = items.flatMap(item => matches.includes(item) ? edit.enabled ? [expression] : [] : [item.getText(source)]);
      if (edit.enabled && !previous) retained.push(expression);
      text = text.slice(0, array.getStart(source)) + `[${retained.join(", ")}]` + text.slice(array.end);
    }
    if (edit.enabled && !imported) text = addResourceImport(root, file, text, alias, "stacks", located);
    if (edit.enabled && addHelper) text = `import { managedPolicy as ${helper} } from "aws-studio/config";\n${text}`;
    overrides.set(file, text);
  }
}
