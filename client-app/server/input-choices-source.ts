import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Mode, ModelResource, SourceLocation } from "../shared/model";
import { inputChoicesError, inputModeIntents, sameInputModes, type ResourceIntent } from "../shared/resources";
import { LOCAL_TEST_ACCOUNT_INPUTS } from "../shared/deployment-inputs";
import { preserveResourceBuilderComments } from "./resource-config-comments";
import { descriptorFactory, frameworkExport } from "./source/factories";
import { sensitiveName } from "./operations/redaction";

const FILES = { deployment: "framework-config/inputs/deployment.ts", local: "cdk-app/framework-inputs.ts" } as const;
const MODES = ["dev", "prod"] as const;

export function frameworkInputBehavior(owner: string, name: string, localTestAccountPolicy?: true) {
  const local = owner === "local" && localTestAccountPolicy && LOCAL_TEST_ACCOUNT_INPUTS.some(input => input === name);
  const availability = owner === "deployment" || local;
  return { availability, fallback: availability && !sensitiveName(name) };
}
/** Where each framework settings group's `input.*` declarations are written. */
export const FRAMEWORK_SETTING_FILES: Readonly<Record<keyof typeof FILES, string>> = FILES;

/** The span of one framework setting's declaration (`key: input.fromEnv(...)`) in its defineInputs call. */
export function locateFrameworkSetting(source: ts.SourceFile, key: string): { readonly start: number; readonly end: number } | undefined {
  const found: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && frameworkExport(source, node.expression) === "defineInputs" && node.arguments[0]) {
      const object = unwrap(node.arguments[0]);
      if (ts.isObjectLiteralExpression(object)) for (const member of object.properties) {
        if (ts.isPropertyAssignment(member) && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === key) found.push(member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.length === 1 ? { start: found[0]!.getStart(source), end: found[0]!.end } : undefined;
}
const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
};

/** Fixed public declaration files only. This authority never accepts a path from a request. */
function choiceFile(root: string, owner: string): string | undefined {
  const relative = FILES[owner as keyof typeof FILES];
  if (!relative) return undefined;
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (!existsSync(current)) return undefined;
    if (lstatSync(current).isSymbolicLink()) throw new Error("Input declarations must be regular repository files, without symbolic links.");
  }
  if (!lstatSync(current).isFile()) throw new Error("Input declarations must be regular repository files.");
  return current;
}

/** Inspect literal builder metadata without executing source or reading any environment values. */
export function frameworkInputChoices(root: string, owner: string, key: string, name: string, overlay: ReadonlyMap<string, string> = new Map()) {
  const file = choiceFile(root, owner);
  if (!file) return undefined;
  const text = overlay.get(file) ?? readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { expression: ts.Expression; catalog: ts.CallExpression }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && frameworkExport(sourceFile, node.expression) === "defineInputs" && node.arguments[0]) {
      const object = unwrap(node.arguments[0]);
      if (ts.isObjectLiteralExpression(object)) for (const member of object.properties) {
        if (ts.isPropertyAssignment(member) && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === key) found.push({ expression: unwrap(member.initializer), catalog: node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (found.length !== 1) return undefined;
  const { expression, catalog } = found[0]!;
  const calls: { name: string; node: ts.CallExpression; receiver: ts.Expression }[] = [];
  let node = expression;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    calls.unshift({ name: node.expression.name.text, node, receiver: node.expression.expression });
    node = unwrap(node.expression.expression);
  }
  if (!calls[0] || descriptorFactory(sourceFile, calls[0].node) !== "fromEnv" || !calls[0].node.arguments[0] || !ts.isStringLiteral(calls[0].node.arguments[0]) || calls[0].node.arguments[0].text !== name) return undefined;
  if (calls.slice(1).some(call => !["enum", "default", "required", "only", "note"].includes(call.name)) || new Set(calls.map(call => call.name)).size !== calls.length) return undefined;
  const enumeration = calls.find(call => call.name === "enum");
  if (enumeration?.node.arguments.some(argument => !ts.isStringLiteral(argument))) return undefined;
  const choices = enumeration?.node.arguments.map(argument => (argument as ts.StringLiteral).text);
  if (choices && (!choices.length || inputChoicesError(choices))) return undefined;
  const defaults: string[] = [];
  const scope = calls.find(call => call.name === "only")?.node.arguments;
  const requirement = calls.find(call => call.name === "required")?.node.arguments;
  const literalMode = (value: ts.Expression | undefined) => !!value && ts.isStringLiteral(value) && (value.text === "dev" || value.text === "prod");
  const literalPolicy = (!scope || scope.length === 1 && literalMode(scope[0])) &&
    (!requirement || requirement.length === 0 || requirement.length === 1 && literalMode(requirement[0]));
  const fallback = calls.find(call => call.name === "default");
  if (fallback) for (const argument of fallback.node.arguments) {
    const value = unwrap(argument);
    if (ts.isStringLiteral(value)) defaults.push(value.text);
    else if (ts.isObjectLiteralExpression(value) && value.properties.every(item => ts.isPropertyAssignment(item) && ts.isStringLiteral(item.initializer)))
      for (const item of value.properties) defaults.push(((item as ts.PropertyAssignment).initializer as ts.StringLiteral).text);
    else return undefined;
  }
  const at = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
  const source: SourceLocation = { file: FILES[owner as keyof typeof FILES], line: at.line + 1, column: at.character + 1, start: expression.getStart(sourceFile), end: expression.end };
  return { file, text, sourceFile, expression, catalog, calls, choices, defaults, source, literalPolicy };
}

/** Remove a legacy requirement from its literal mode list while retaining surrounding comments. */
function removeLegacyRequirement(text: string, file: string, mode: Mode, name: string): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === "REQUIRED_FRAMEWORK_INPUTS");
  const object = declaration?.initializer && unwrap(declaration.initializer);
  const property = object && ts.isObjectLiteralExpression(object) && object.properties.find(item =>
    ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === mode);
  const list = property && ts.isPropertyAssignment(property) && unwrap(property.initializer);
  if (!list || !ts.isArrayLiteralExpression(list) || list.elements.some(element => !ts.isStringLiteral(element))) {
    throw new Error("The legacy framework input requirements are computed. Edit the mode's requirements in cdk-app/framework-inputs.ts.");
  }
  const matches = list.elements.filter(element => ts.isStringLiteral(element) && element.text === name);
  const tokens = list.getChildren(source).find(node => node.kind === ts.SyntaxKind.SyntaxList)!.getChildren(source);
  const removals = new Set<ts.Node>();
  for (const item of matches) {
    const index = tokens.indexOf(item);
    removals.add(item);
    const comma = tokens[index + 1]?.kind === ts.SyntaxKind.CommaToken ? tokens[index + 1] : tokens[index - 1];
    if (comma?.kind === ts.SyntaxKind.CommaToken) removals.add(comma);
  }
  for (const token of [...removals].sort((a, b) => b.pos - a.pos)) {
    text = text.slice(0, token.getStart(source)) + text.slice(token.end);
  }
  return text;
}

export function planFrameworkInputSettings(root: string, resource: ModelResource, intent: ResourceIntent, overlay: ReadonlyMap<string, string>) {
  if (!resource.inputChoices || intent.kind !== "input" || intent.fromEnv !== resource.fromEnv || intent.group !== resource.path.slice(0, -1).join(".") || Object.keys(intent.requirements).length)
    throw new Error("Framework input edits must preserve the reader, variable name and group.");
  const owner = resource.frameworkInput!;
  const name = resource.fromEnv!;
  const editable = resource.inputChoices;
  const current = inputModeIntents(resource);
  const choices = intent.choices?.map(value => value.trim());
  const error = choices && inputChoicesError(choices);
  if (error) throw new Error(error);
  if (choices !== undefined && sensitiveName(name)) throw new Error("Enter the credential in the protected environment file.");
  const facts = frameworkInputChoices(root, owner, resource.path.at(-1)!, name, overlay);
  if (!facts) throw new Error("This input's declaration is computed or unavailable. Edit its settings in source.");
  const modes = intent.modes;
  const policyChanged = !sameInputModes(current, modes);
  const availabilityChanged = MODES.some(mode => current[mode].present !== modes[mode].present);
  if (policyChanged && !facts.literalPolicy) throw new Error("The input's mode policy is computed. Edit its settings in source.");
  const available = MODES.filter(mode => modes[mode].present);
  if (owner === "deployment" && !available.length) throw new Error("Keep this deployment input available in at least one environment.");
  for (const mode of MODES) {
    const policy = modes[mode];
    if (policy.value != null || (!policy.present && (policy.required || policy.default !== null)))
      throw new Error("Unavailable inputs cannot have a value or be required.");
    if (policy.present !== current[mode].present && (!editable.availability || owner === "local" && mode === "prod"))
      throw new Error("This reader controls where the input is available.");
    if (policy.default !== current[mode].default && (!editable.fallback || !policy.default?.trim() && policy.default !== null))
      throw new Error("Use a non-blank public default or leave the default empty.");
  }
  const defaults = editable.fallback ? MODES.flatMap(mode => modes[mode].default ?? []) : facts.defaults;
  const allowed = choices ?? facts.choices;
  if (allowed?.length && defaults.some(value => !allowed.includes(value))) throw new Error("Every declared default must be one of the allowed values.");

  const original = facts.expression.getText(facts.sourceFile);
  const start = facts.expression.getStart(facts.sourceFile);
  const changes = new Map<string, string>();
  if (choices !== undefined) changes.set("enum", choices.length ? `.enum(${choices.map(value => JSON.stringify(value)).join(", ")})` : "");
  if (policyChanged) {
    if (availabilityChanged) {
      // The local reader runs only in development. Scoping its declaration out
      // of development disables it without deleting its identity or file value.
      const scope = owner === "local" ? modes.dev.present ? "dev" : "prod" : available.length === 1 ? available[0] : undefined;
      changes.set("only", scope ? `.only("${scope}")` : "");
    }
    const required = facts.calls.find(call => call.name === "required")?.node.arguments;
    const authored = required?.length === 0 ? "both" : required?.[0] && ts.isStringLiteral(required[0]) ? required[0].text : undefined;
    if (availabilityChanged || MODES.some(mode => current[mode].required !== modes[mode].required)) {
      const next = available.filter(mode => modes[mode].required && (!current[mode].required || authored === mode || authored === "both"));
      changes.set("required", next.length === 2 ? ".required()" : next.length ? `.required("${next[0]}")` : "");
    }
    if (editable.fallback && (availabilityChanged || MODES.some(mode => current[mode].default !== modes[mode].default))) {
      const members = available.flatMap(mode => modes[mode].default === null ? [] : [`${mode}: ${JSON.stringify(modes[mode].default)}`]);
      const shared = members.length > 0 && members.length === available.length && available.every(mode => modes[mode].default === modes[available[0]!].default);
      changes.set("default", shared ? `.default(${JSON.stringify(modes[available[0]!].default)})` : members.length ? `.default({ ${members.join(", ")} })` : "");
    }
  }
  let desired = facts.calls[0]!.node.getText(facts.sourceFile);
  for (const call of facts.calls.slice(1)) {
    desired += changes.get(call.name) ?? facts.text.slice(call.receiver.end, call.node.end);
    changes.delete(call.name);
  }
  desired += [...changes.values()].join("");
  const rewritten = preserveResourceBuilderComments(original, desired);
  if (!rewritten) throw new Error("This input edit would discard a source comment. Resolve that comment in source, then review again.");
  let text = facts.text;
  if (policyChanged && owner === "local" && facts.catalog.arguments.length === 1) {
    const argumentsEnd = facts.catalog.arguments.end;
    const separator = facts.catalog.arguments.hasTrailingComma ? "" : ",";
    text = text.slice(0, argumentsEnd) + `${separator} { mode: "dev" }` + text.slice(argumentsEnd);
  }
  const overrides = { ...Object.fromEntries(overlay), [facts.file]: text.slice(0, start) + rewritten + text.slice(facts.expression.end) };
  const legacyModes = MODES.filter(mode => editable.legacyRequired?.includes(mode) && !modes[mode].required &&
    (current[mode].required || modes[mode].present && !current[mode].present));
  if (legacyModes.length) {
    const file = choiceFile(root, "local");
    if (!file) throw new Error("The framework requirements declaration moved. Refresh Studio before trying again.");
    overrides[file] = legacyModes.reduce((text, mode) => removeLegacyRequirement(text, file, mode, name), overrides[file] ?? readFileSync(file, "utf8"));
  }
  return { overrides, nextResource: resource.id };
}
