import ts from "typescript";

/** Declaration/handler pairing also applies to disabled and single-lane events. */
export function assertEventReplayEntry(id: string, localReplay: boolean, source: string): void {
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const aliases = new Set<string>(), namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "aws-studio/runtime/event-replay" || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && ["withLocalReplay", "captureEventDrivenInvocation"].includes(item.propertyName?.text ?? item.name.text)) aliases.add(item.name.text);
  }
  let wrapped = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && aliases.has(expression.text) || ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) && ["withLocalReplay", "captureEventDrivenInvocation"].includes(expression.name.text)) wrapped = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (localReplay && !wrapped) throw new Error(`events["${id}"] declares localReplay: true, but its handler does not use withLocalReplay. Export the handler with withLocalReplay from "aws-studio/runtime/event-replay".`);
  if (!localReplay && wrapped) throw new Error(`The handler for events["${id}"] uses withLocalReplay, but its declaration does not declare localReplay: true. Add the flag, or remove the wrapper.`);
}
