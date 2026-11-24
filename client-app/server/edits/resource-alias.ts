import path from "node:path";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { locateConfigSource, type LocatedConfigSource } from "aws-studio/source-index";
import { frameworkExport } from "../source/factories";
import { unwrap } from "../source/syntax";
export type CatalogName = "inputs" | "stacks";
export function catalogModule(root: string, name: CatalogName, located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root })) {
  const item = located.properties[name];
  if (!item) throw new Error(`The ${name} catalog module could not be located.`);
  const source = ts.createSourceFile(item.file, readFileSync(item.file, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(ts.isVariableStatement).filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).flatMap(statement => [...statement.declarationList.declarations]).filter(declaration => {
    if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return false;
    const value = unwrap(declaration.initializer);
    return ts.isCallExpression(value) && frameworkExport(source, value.expression) === (name === "inputs" ? "defineInputs" : "defineStacks") || declaration.initializer.getStart(source) <= item.span.start && declaration.initializer.end >= item.span.end;
  });
  const declaration = declarations.find(declaration => declaration.initializer!.getStart(source) <= item.span.start && declaration.initializer!.end >= item.span.end) ?? (declarations.length === 1 ? declarations[0] : undefined);
  if (!declaration && declarations.length > 1) throw new Error(`The configured ${name} catalog export is ambiguous. Open its declaration.`);
  return { file: item.file, exported: declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : name };
}
function sameModule(from: string, specifier: string, target: string): boolean {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.[jt]s$/, ""));
  return [base, `${base}.ts`, path.join(base, "index.ts")].includes(target);
}
export function resourceAlias(root: string, file: string, source: ts.SourceFile, text: string, catalog: CatalogName = "stacks", located?: LocatedConfigSource) {
  const target = catalogModule(root, catalog, located);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".") || statement.importClause?.isTypeOnly || !sameModule(file, statement.moduleSpecifier.text, target.file)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) return { alias: `${bindings.name.text}.${target.exported}`, imported: true };
    const found = bindings && ts.isNamedImports(bindings) ? bindings.elements.find(item => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === target.exported) : undefined;
    if (found) return { alias: found.name.text, imported: true };
  }
  let alias: string = catalog;
  for (let suffix = 2; new RegExp(`\\b${alias}\\b`).test(text); suffix++) alias = `${catalog}${suffix}`;
  return { alias, imported: false };
}
export function addResourceImport(root: string, file: string, text: string, alias: string, catalog: CatalogName = "stacks", located?: LocatedConfigSource): string {
  const target = catalogModule(root, catalog, located);
  let specifier = path.relative(path.dirname(file), target.file).replaceAll("\\", "/").replace(/\.ts$/, "").replace(/\/index$/, "");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return `import { ${target.exported}${alias === target.exported ? "" : ` as ${alias}`} } from ${JSON.stringify(specifier)};\n${text}`;
}
