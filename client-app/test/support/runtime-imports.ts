import { readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/** Executable module specifiers in one source file; type-only imports and re-exports are not. */
export function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      if (!onlyTypes && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      const value = node.arguments[0];
      if (value && ts.isStringLiteral(value)) names.push(value.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Every specifier in one file, type-only imports included. */
export function allSpecifiers(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
      const value = node.arguments[0];
      if (value && ts.isStringLiteral(value)) names.push(value.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) names.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** TypeScript sources under `directory`, skipping dependencies, build output and browser fixtures. */
export async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".dist"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(file));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(file);
  }
  return files;
}
