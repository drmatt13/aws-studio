import ts from "typescript";

/** Resolve only official framework imports, including named and namespace aliases. */
export function frameworkExport(source: ts.SourceFile, expression: ts.Expression): string | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "aws-studio/config" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && ts.isIdentifier(expression)) {
      const binding = bindings.elements.find(binding => !binding.isTypeOnly && binding.name.text === expression.text);
      if (binding) return binding.propertyName?.text ?? binding.name.text;
    }
    if (bindings && ts.isNamespaceImport(bindings) && ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === bindings.name.text) return expression.name.text;
  }
  return undefined;
}

export function descriptorFactory(source: ts.SourceFile, call: ts.CallExpression): string | undefined {
  const direct = frameworkExport(source, call.expression);
  if (direct === "stack" || direct === "cdk") return direct;
  const access = call.expression;
  return ts.isPropertyAccessExpression(access) && frameworkExport(source, access.expression) === "input" && ["fromEnv", "value", "secret"].includes(access.name.text) ? access.name.text : undefined;
}
