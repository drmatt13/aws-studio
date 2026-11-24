import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import type { LocatedConfigSource } from "aws-studio/source-index";
import type { ModeModel, SourceLocation } from "../../shared/model";
import { permissionStatementInput, permissionStatementKey, readPermissionStatement, type PermissionResourceInput, type PermissionStatementInput, type PolicyRule } from "../../shared/permission-rules";
import { sha256 } from "../files";
import { parseOrigin } from "../model/origin";
import { resourceAlias } from "../edits/resource-alias";
import { frameworkExport } from "./factories";
import { declarationObject, expressionAt, lineAndColumn, literalKey, parse, propertyAt, unwrap } from "./syntax";

export function policyRuleId(location: SourceLocation, text: string): string { return `policy:${sha256(`${location.file}:${location.start}:${location.end}:${text}`)}`; }
/** Follow literal const/import/object references without evaluating any application module. */
export function discoverPolicyRules(root: string, model: ModeModel, located: LocatedConfigSource, read = (file: string) => readFileSync(file, "utf8")): readonly PolicyRule[] {
  const sources = new Map<string, ts.SourceFile>();
  const source = (file: string) => { const key = path.resolve(file); let item = sources.get(key); if (!item) { item = parse(key, read(key)); sources.set(key, item); } return item; };
  const moduleFile = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return;
    const base = path.resolve(path.dirname(from), specifier).replace(/\.[cm]?js$/, "");
    return [base, `${base}.ts`, path.join(base, "index.ts")].find(file => existsSync(file) && file.endsWith(".ts"));
  };
  const exported = (file: string, name: string, seen = new Set<string>()): ts.Expression | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const module = source(file);
    for (const statement of module.statements) {
      if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && statement.declarationList.flags & ts.NodeFlags.Const) {
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration?.initializer) return declaration.initializer;
      }
      if (name === "default" && ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? moduleFile(file, statement.moduleSpecifier.text) : undefined;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const alias = statement.exportClause.elements.find(item => !item.isTypeOnly && item.name.text === name);
        if (alias) return target ? exported(target, alias.propertyName?.text ?? alias.name.text, seen) : alias.propertyName ?? alias.name;
      } else if (!statement.exportClause && target) { const expression = exported(target, name, seen); if (expression) return expression; }
    }
    return undefined;
  };
  const resolve = (expression: ts.Expression, seen = new Set<string>()): ts.Expression => {
    const value = unwrap(expression), file = value.getSourceFile(), key = `${file.fileName}:${value.pos}:${value.end}`;
    if (seen.has(key)) return value;
    seen.add(key);
    if (ts.isIdentifier(value)) {
      const declaration = file.statements.filter(ts.isVariableStatement).filter(item => item.declarationList.flags & ts.NodeFlags.Const).flatMap(item => [...item.declarationList.declarations]).find(item => ts.isIdentifier(item.name) && item.name.text === value.text);
      if (declaration?.initializer) return resolve(declaration.initializer, seen);
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const bindings = statement.importClause?.namedBindings, target = moduleFile(file.fileName, statement.moduleSpecifier.text);
        const binding = bindings && ts.isNamedImports(bindings) && bindings.elements.find(item => !item.isTypeOnly && item.name.text === value.text);
        const name = binding ? binding.propertyName?.text ?? binding.name.text : statement.importClause?.name?.text === value.text ? "default" : undefined;
        const entry = target && name ? exported(target, name) : undefined;
        if (entry) return resolve(entry, seen);
      }
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const owner = resolve(value.expression, seen), name = ts.isPropertyAccessExpression(value) ? value.name.text : value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression) ? value.argumentExpression.text : undefined;
      if (ts.isIdentifier(owner) && name) {
        for (const statement of owner.getSourceFile().statements) {
          const bindings = ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly ? statement.importClause?.namedBindings : undefined;
          if (!bindings || !ts.isNamespaceImport(bindings) || bindings.name.text !== owner.text || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
          const target = moduleFile(owner.getSourceFile().fileName, statement.moduleSpecifier.text), entry = target && exported(target, name);
          if (entry) return resolve(entry, seen);
        }
      }
      if (ts.isObjectLiteralExpression(owner) && name) {
        const property = owner.properties.find(item => literalKey(item) === name);
        if (property && ts.isPropertyAssignment(property)) return resolve(property.initializer, seen);
      }
    }
    return value;
  };
  const literal = (expression: ts.Expression): unknown => {
    const value = resolve(expression);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isNumericLiteral(value)) return Number(value.text);
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) return -Number(value.operand.text);
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (value.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(value) && !value.elements.some(ts.isSpreadElement)) return value.elements.map(literal);
    if (ts.isObjectLiteralExpression(value)) {
      const entries = value.properties.map(property => { const key = literalKey(property); if (!key || !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Computed policy value."); return [key, literal(property.initializer)] as const; });
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Duplicate policy key.");
      return Object.fromEntries(entries);
    }
    throw new Error("Computed policy value.");
  };
  const pathOf = (value: ts.Expression): string[] | undefined => {
    value = unwrap(value);
    if (ts.isIdentifier(value)) return [value.text];
    if (ts.isPropertyAccessExpression(value)) { const parent = pathOf(value.expression); return parent && [...parent, value.name.text]; }
    if (ts.isElementAccessExpression(value) && value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression)) { const parent = pathOf(value.expression); return parent && [...parent, value.argumentExpression.text]; }
    return undefined;
  };
  const resource = (expression: ts.Expression): PermissionResourceInput => {
    const value = unwrap(expression);
    if (ts.isStringLiteralLike(value)) return { kind: "literal", value: value.text };
    if (ts.isCallExpression(value) && frameworkExport(value.getSourceFile(), value.expression) === "targetArn" && value.arguments.length === 1 && ts.isStringLiteralLike(value.arguments[0]!)) return { kind: "target", target: value.arguments[0]!.text };
    if (ts.isObjectLiteralExpression(value)) {
      const base = value.properties.find(item => literalKey(item) === "resource"), suffix = value.properties.find(item => literalKey(item) === "suffix");
      if (!base || !ts.isPropertyAssignment(base) || value.properties.some(item => !["resource", "suffix"].includes(literalKey(item) ?? ""))) throw new Error("Computed IAM reference.");
      return { ...resource(base.initializer), ...(suffix && ts.isPropertyAssignment(suffix) ? { suffix: literal(suffix.initializer) as string } : {}) };
    }
    const file = value.getSourceFile(), reference = pathOf(value), alias = resourceAlias(root, file.fileName, file, file.text, "stacks", located);
    const prefix = alias.alias.split(".");
    if (!alias.imported || !reference || reference.length < prefix.length + 2 || prefix.some((part, index) => reference[index] !== part)) throw new Error("Computed IAM reference.");
    return { kind: "catalog", resource: `resource:${reference.slice(prefix.length, -1).join(".")}`, attribute: reference.at(-1)! };
  };
  const statement = (expression: ts.Expression): PermissionStatementInput => {
    const value = resolve(expression);
    if (!ts.isObjectLiteralExpression(value)) throw new Error("Computed policy statement.");
    const result: Record<string, unknown> = {};
    for (const property of value.properties) {
      const key = literalKey(property);
      if (!key || !ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name) || Object.hasOwn(result, key)) throw new Error("Computed policy statement.");
      const initial = resolve(property.initializer);
      result[key] = key === "resources" && ts.isArrayLiteralExpression(initial) && !initial.elements.some(ts.isSpreadElement) ? initial.elements.map(resource) : literal(initial);
    }
    return readPermissionStatement(result);
  };
  const rules = new Map<string, PolicyRule>();
  const statementKey = permissionStatementKey;
  const location = (node: ts.Node): SourceLocation => { const file = node.getSourceFile(), start = node.getStart(file); return { file: path.relative(root, file.fileName).replaceAll("\\", "/"), ...lineAndColumn(file, start), start, end: node.end }; };
  for (const target of model.targets) for (const origin of target.origins) {
    const parsed = parseOrigin(origin), entry = parsed && parsed.section !== "defaults" && located.sections[parsed.section]?.find(entry => entry.key === parsed.key);
    if (!entry || !parsed) continue;
    const file = source(entry.file), expression = expressionAt(file, entry.valueSpan.start, entry.valueSpan.end), declaration = expression && declarationObject(expression, parsed.section, parsed.chain);
    if (!declaration || "unsupported" in declaration) continue;
    const access = propertyAt(declaration.object, ["cloud", "access"]);
    if (!access.property) continue;
    const unresolved: ts.Expression[] = [];
    const visit = (expression: ts.Expression, seen = new Set<ts.Expression>()): void => {
      const resolved = resolve(expression);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      if (!ts.isArrayLiteralExpression(resolved)) { unresolved.push(resolved); return; }
      for (const element of resolved.elements) {
        if (ts.isSpreadElement(element)) { visit(element.expression, seen); continue; }
        const node = resolve(element), site = location(node), id = policyRuleId(site, node.getText());
        let input: PermissionStatementInput;
        try { input = statement(node); } catch { continue; }
        let matches = false;
        try { matches = target.access.some(item => statementKey(item.statement ?? permissionStatementInput(item)) === statementKey(input)); } catch { /* An unsupported evaluated projection stays inspectable through source. */ }
        const writable = matches && (site.file === "framework.config.ts" || site.file.startsWith("framework-config/")) && ts.isObjectLiteralExpression(node) && ts.isArrayLiteralExpression(node.parent);
        const previous = rules.get(id), consumers = [...new Set([...(previous?.consumers ?? []), target.ref])];
        rules.set(id, { id, consumers, location: site, writable, ...(writable ? {} : { reason: matches ? "This policy is computed. Open its owning declaration." : "The source policy differs from evaluated access. Open its owning declaration." }), shared: consumers.length > 1 || site.file !== path.relative(root, entry.file).replaceAll("\\", "/"), statement: input });
      }
    };
    visit(access.property.initializer);
    for (const [index, evaluated] of target.access.entries()) {
      let input: PermissionStatementInput;
      try { input = evaluated.statement ?? permissionStatementInput(evaluated); } catch { continue; }
      if ([...rules.values()].some(rule => rule.consumers.includes(target.ref) && statementKey(rule.statement) === statementKey(input))) continue;
      const node = unresolved[0] ?? resolve(access.property.initializer), site = location(node), id = `${policyRuleId(site, node.getText())}:${index}`;
      const previous = rules.get(id), consumers = [...new Set([...(previous?.consumers ?? []), target.ref])];
      rules.set(id, { id, consumers, location: site, statement: input, writable: false, shared: consumers.length > 1, reason: "This IAM policy is computed. Open its owning declaration to preserve its source logic." });
    }
  }
  return [...rules.values()];
}
