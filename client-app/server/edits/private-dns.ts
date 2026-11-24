import path from "node:path";
import { readdirSync } from "node:fs";
import ts from "typescript";
import { locateConfigSource } from "aws-studio/source-index";
import type { PrivateZoneEdit } from "../../shared/private-dns";
import type { StudioState } from "../snapshot";
import { SourceFiles } from "../source";
import { parse, unwrap, findProperty, hasComments, expressionAt } from "../source/syntax";
import { importedVpc, referencesModule } from "../source/networks";
import { toRelative, assertWritable } from "../files";
import { importVpc, pruneUnusedVpcImports } from "./networks";
import { assertCreationFile, objectCall, setProperty } from "./creation";
import { insertExpression } from "../resources-source";
import { removeElement, removeStatement } from "./source-cleanup";
import { EditError, sourceContents } from "aws-studio/source/io";

const located = (root: string, files: SourceFiles) => locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });

function rootRegistry(root: string, files: SourceFiles) {
  const file = assertWritable(root, "framework.config.ts");
  const text = files.text(file);
  const { source, object } = objectCall(file, text, "defineFrameworkConfig");
  const property = findProperty(object, "privateHostedZones");
  if (property.spread || property.property && !ts.isPropertyAssignment(property.property)) throw new EditError(422, "Compose privateHostedZones as a literal array of imported zone declarations.");
  const array = property.property && ts.isPropertyAssignment(property.property) ? unwrap(property.property.initializer) : undefined;
  if (array && (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement))) throw new EditError(422, "Compose privateHostedZones as a literal array of imported zone declarations.");
  return { file, text, source, object, array: array as ts.ArrayLiteralExpression | undefined };
}

/** A narrow literal writer. All results enter BatchEditor's normal overlay,
 * both-mode evaluation, source gate, diff review, journal and guarded rollback. */
export function planPrivateZone(root: string, state: StudioState, edit: PrivateZoneEdit, overrides: Map<string, string>): { readonly files: readonly string[]; readonly deletions: readonly { file: string; before: string; after: null }[] } {
  let files = new SourceFiles(overrides);
  let sourceIndex = located(root, files);
  const entry = sourceIndex.privateHostedZones.find(zone => zone.id === edit.id);
  const known = Object.values(state.snapshot.models).some(model => model.privateHostedZones?.some(zone => zone.id === edit.id));
  if (edit.operation === "create" ? entry || known : !entry || !known) throw new EditError(422, edit.operation === "create" ? "This private zone identity already exists." : "The private zone's exported declaration cannot be located.");
  const changed: string[] = [];
  if (edit.operation === "remove") {
    const registry = rootRegistry(root, files);
    if (!registry.array) throw new EditError(422, "The private zone registry cannot be located.");
    const imported = registry.source.statements.find((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && referencesModule(registry.file, statement.moduleSpecifier.text, entry!.file));
    const bindings = imported?.importClause?.namedBindings;
    const binding = bindings && ts.isNamedImports(bindings) ? bindings.elements.find(binding => (binding.propertyName?.text ?? binding.name.text) === entry!.exportName) : undefined;
    const element = binding && registry.array.elements.find(value => ts.isIdentifier(value) && value.text === binding.name.text);
    if (!element || !imported || !binding || !bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1 || imported.importClause?.name) throw new EditError(422, "The zone registry has shared or computed imports. Remove the zone in source to preserve those imports.");
    const consumers: string[] = [];
    const skip = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage"]);
    const visit = (directory: string): void => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (skip.has(item.name) || item.isSymbolicLink()) continue;
        const file = path.join(directory, item.name);
        if (item.isDirectory()) visit(file);
        else if (item.isFile() && /\.[cm]?[jt]sx?$/.test(item.name) && file !== entry!.file && file !== registry.file) {
          const source = files.get(file);
          const scan = (node: ts.Node): void => { if (ts.isStringLiteralLike(node) && referencesModule(file, node.text, entry!.file)) consumers.push(toRelative(root, file)); ts.forEachChild(node, scan); };
          scan(source);
        }
      }
    };
    visit(root);
    let references = 0;
    const scanRoot = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === binding.name.text) references++; ts.forEachChild(node, scanRoot); };
    scanRoot(registry.source);
    if (consumers.length || references !== 2 + Number(!!binding.propertyName && binding.propertyName.text === binding.name.text)) throw new EditError(422, "The private zone has additional source consumers. Remove or reassign those references first.");
    const declaration = files.get(entry!.file), before = files.text(entry!.file);
    const variables = declaration.statements.filter(ts.isVariableStatement);
    const onlyZoneImports = declaration.statements.filter(ts.isImportDeclaration).every(statement => {
      const bindings = statement.importClause?.namedBindings;
      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.name || !bindings || !ts.isNamedImports(bindings)) return false;
      const specifier = statement.moduleSpecifier.text;
      return bindings.elements.every(binding => specifier === "aws-studio/config"
        ? (binding.propertyName ?? binding.name).text === "definePrivateHostedZone"
        : !!importedVpc(entry!.file, declaration, binding.name, sourceIndex));
    });
    if (hasComments(before) || !onlyZoneImports || variables.length !== 1 || variables[0]!.declarationList.declarations.length !== 1 || declaration.statements.some(statement => !ts.isImportDeclaration(statement) && !ts.isVariableStatement(statement) && !ts.isEmptyStatement(statement))) throw new EditError(422, "This zone module contains comments or other code. Remove it in source so that content is preserved deliberately.");
    let text = removeElement(registry.text, registry.array, element, registry.source);
    const reparsed = parse(registry.file, text);
    const oldImport = reparsed.statements.find(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && referencesModule(registry.file, statement.moduleSpecifier.text, entry!.file))!;
    text = removeStatement(text, oldImport, reparsed);
    overrides.set(registry.file, text);
    return { files: [registry.file, entry!.file], deletions: [{ file: assertWritable(root, toRelative(root, entry!.file)), before, after: null }] };
  }
  for (const id of edit.settings.vpcIds) if (!sourceIndex.networks.some(network => network.id === id)) throw new EditError(422, `VPC ${id} must be a registered exported declaration.`);
  const file = entry ? assertWritable(root, toRelative(root, entry.file)) : assertCreationFile(root, `framework-config/private-dns/${edit.id}.ts`);
  let text: string;
  let symbol: string | undefined;
  if (entry) text = files.text(file);
  else {
    if (sourceContents(file) !== null) throw new EditError(409, "The private zone file already exists. Register or inspect it in source; existing files are never overwritten by creation.");
    const registry = rootRegistry(root, files);
    const identifiers = new Set<string>();
    const inspect = (node: ts.Node): void => { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, inspect); };
    inspect(registry.source);
    const base = `${edit.id.replace(/-([a-z0-9])/g, (_, value: string) => value.toUpperCase())}PrivateZone`;
    symbol = base;
    for (let n = 2; identifiers.has(symbol); n++) symbol = `${base}${n}`;
    text = `import { definePrivateHostedZone } from "aws-studio/config";\n\nexport const ${symbol} = definePrivateHostedZone({ id: ${JSON.stringify(edit.id)}, name: ${JSON.stringify(edit.settings.name)}, vpcs: [], records: [], enabled: ${edit.settings.enabled} });\n`;
    const next = registry.array ? registry.text.slice(0, registry.array.end - 1) + `${registry.array.elements.length && !registry.array.elements.hasTrailingComma ? "," : ""}\n  ${symbol},\n` + registry.text.slice(registry.array.end - 1)
      : insertExpression(registry.text, registry.source, registry.object, ["privateHostedZones"], `[${symbol}]`);
    overrides.set(registry.file, `import { ${symbol} } from ${JSON.stringify(`./framework-config/private-dns/${edit.id}`)};\n${next}`);
    overrides.set(file, text);
    changed.push(registry.file);
  }
  const vpcs: string[] = [];
  for (const id of edit.settings.vpcIds) { const imported = importVpc(file, text, id, sourceIndex); text = imported.text; vpcs.push(imported.symbol); }
  const objectAt = () => {
    overrides.set(file, text); files = new SourceFiles(overrides); sourceIndex = located(root, files);
    const current = sourceIndex.privateHostedZones.find(zone => zone.id === edit.id);
    const source = files.get(file);
    const call = current && expressionAt(source, current.span.start, current.span.end);
    const object = call && ts.isCallExpression(unwrap(call)) ? unwrap((unwrap(call) as ts.CallExpression).arguments[0]!) : undefined;
    if (!object || !ts.isObjectLiteralExpression(object)) throw new EditError(422, "The private zone declaration is computed. Edit its settings in source.");
    return { source, object };
  };
  const previous = state.snapshot.models.dev.privateHostedZones?.find(zone => zone.id === edit.id) ?? state.snapshot.models.prod.privateHostedZones?.find(zone => zone.id === edit.id);
  for (const [key, value] of Object.entries({ name: edit.settings.name, enabled: edit.settings.enabled, records: edit.settings.records })) {
    if (previous && JSON.stringify(previous[key as "name" | "enabled" | "records"]) === JSON.stringify(value)) continue;
    const { source, object } = objectAt();
    text = setProperty(file, text, object, source, key, JSON.stringify(value, null, 2));
  }
  if (!previous || JSON.stringify(previous.vpcIds) !== JSON.stringify(edit.settings.vpcIds)) {
    const { source, object } = objectAt();
    const property = findProperty(object, "vpcs");
    if (!property.property || !ts.isPropertyAssignment(property.property) || !ts.isArrayLiteralExpression(property.property.initializer) || property.property.initializer.elements.some(element => !ts.isExpression(element) || !importedVpc(file, source, element, sourceIndex)) || hasComments(property.property.initializer.getText(source))) {
      // A just-created empty array has no computed entries.
      if (entry) throw new EditError(422, "The VPC associations are computed or contain comments. Edit them in source.");
    }
    if (!property.property || !ts.isPropertyAssignment(property.property)) throw new EditError(422, "Declare an explicit vpcs array before editing associations.");
    const old = property.property.initializer;
    text = text.slice(0, old.getStart(source)) + `[${vpcs.join(", ")}]` + text.slice(old.end);
  }
  text = pruneUnusedVpcImports(file, text, sourceIndex);
  overrides.set(file, text.endsWith("\n") ? text : `${text}\n`);
  return { files: [...changed, file], deletions: [] };
}
