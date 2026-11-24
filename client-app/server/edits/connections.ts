import { resourceAlias, addResourceImport } from "./resource-alias";
import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "aws-studio/source-index";
import type { DraftEdit } from "../../shared/api";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { declarationObject, hasComments, propertyAt, unwrap } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { removeProperty } from "./splice";
import { planPlacement } from "./networks";
import { EditError } from "aws-studio/source/io";
import { planNativeBinding } from "./native-binding";
import { planResourceAccess } from "./resource-access";
import { invocationAccessReason } from "../../shared/workload-operations";

type Connection = Extract<DraftEdit, { kind: "connection" }>;
function planCatalogConnection(root: string, state: StudioState, edit: Connection, overrides: Map<string, string>): void {
  const target = Object.values(state.snapshot.models).flatMap(model => model.targets).find(item => item.ref === edit.target);
  const resource = Object.values(state.snapshot.models).flatMap(model => model.resources).find(item => item.id === edit.destination);
  if (!target || !resource || !/^resource:(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(resource.id)) throw new EditError(422, "Select a declared catalog resource.");
  const permissionCapability = state.snapshot.source.permissionCapabilities?.find(item => item.resource === resource.id);
  const nativeSecret = permissionCapability?.category === "secret" && !!permissionCapability.stack;
  if (nativeSecret && edit.enabled) {
    if (permissionCapability.reason) throw new EditError(422, permissionCapability.reason);
  }
  const secret = resource.kind === "secret" || nativeSecret;
  if (!["input", "secret"].includes(resource.kind) && !nativeSecret) throw new EditError(422, "Input delivery supports catalog inputs and secrets; native construct attributes remain source-owned.");
  if (!/^[A-Z][A-Z0-9_]*$/.test(edit.variable ?? "")) throw new EditError(422, "Enter an uppercase consumer environment variable.");
  const delivered = new Set(Object.values(state.snapshot.models).flatMap(model => model.targets).filter(item => item.ref === edit.target).flatMap(item => [...item.environment, ...item.secrets].map(entry => entry.name)));
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides), parsed = parseOrigin(origin), located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry);
    if (!entry || !value || !parsed) throw new EditError(422, "The consumer declaration cannot be located.");
    const declaration = declarationObject(value, parsed.section, parsed.chain);
    if ("unsupported" in declaration) throw new EditError(422, declaration.unsupported);
    const file = assertWritable(root, toRelative(root, entry.file)), source = files.get(file);
    let text = files.text(file);
    const catalog = !nativeSecret && ["input", "secret"].includes(resource.kind) ? "inputs" : "stacks";
    const { alias, imported } = resourceAlias(root, file, source, text, catalog, located);
    const reference = `${alias}${resource.path.map(part => `[${JSON.stringify(part)}]`).join("")}`;
    const container = target.kind === "service" || target.kind === "task";
    const keys = [container && secret ? "secrets" : "environment", edit.variable!];
    const position = propertyAt(declaration.object, keys);
    // A new variable follows a spread in its own map, so it wins; the evaluated workload says whether the spread already supplies it.
    const afterSpread = edit.enabled && position.editability.kind === "spread" && position.missing.length === 1;
    if (afterSpread && delivered.has(edit.variable!)) throw new EditError(422, "This environment variable already exists. Choose another name or disconnect its current mapping first.");
    if (!afterSpread && (["spread", "unsupported"].includes(position.editability.kind) || position.editability.kind === "computed" && !position.property)) throw new EditError(422, "This binding map is computed. Edit it in source.");
    if (!edit.enabled) {
      if (!position.property) throw new EditError(422, "This consumer variable is not declared here.");
      const delivered = [...target.environment, ...target.secrets].find(item => item.name === edit.variable);
      if (!delivered || !JSON.stringify(delivered).includes(resource.id)) throw new EditError(422, "This variable belongs to another mapping. Inspect it in source before removal.");
      if (hasComments(position.property.getText(source))) throw new EditError(422, "This mapping contains comments. Edit it in source to preserve them.");
      text = removeProperty(text, source, position.container, position.property);
    } else {
      if (position.property) throw new EditError(422, "This environment variable already exists. Choose another name or disconnect its current mapping first.");
      text = insertExpression(text, source, position.container, position.missing, reference + (secret ? container ? ".value" : ".arn" : ""));
    }
    if (edit.enabled && !imported) text = addResourceImport(root, file, text, alias, catalog, located);
    overrides.set(file, text);
  }
}
/** Source-backed declaration operations with exact matching and separate deployment readiness. */
export function planConnection(root: string, state: StudioState, edit: Connection, overrides: Map<string, string>): void {
  const models = Object.values(state.snapshot.models);
  const target = models.flatMap(model => model.targets).find(target => target.ref === edit.target);
  if (!target || target.kind === "workflow") throw new EditError(422, "Select a compute workload to configure a connection.");
  if (!["database", "userPool", "runsTask", "startsWorkflow", "invokesAgent", "resource", "grant", "resourceAccess", "managedPolicy"].includes(edit.connection) || typeof edit.enabled !== "boolean") throw new EditError(422, "Choose a supported connection operation.");
  if (edit.connection === "resourceAccess") { planResourceAccess(root, state, edit, overrides); return; }
  if (edit.connection === "grant" || edit.connection === "managedPolicy") { planNativeBinding(root, state, edit, overrides); return; }
  if (edit.connection === "resource") { planCatalogConnection(root, state, edit, overrides); return; }
  const simple = edit.connection === "database" || edit.connection === "userPool";
  if (edit.connection === "database") {
    if (target.kind === "agent") throw new EditError(422, "Database access belongs in an agent's tool, not the agent.");
    if (edit.enabled && target.role === "event" && target.compute.kind === "lambda" && !target.compute.localReplay) throw new EditError(422, "An AWS-invoked event reaches local PostgreSQL only through local replay. Enable replay for an asynchronous compatible trigger first; a synchronous workflow step must keep its response and cannot use that capture path.");
    const database = state.snapshot.models.prod.managedDatabase;
    if (!database) throw new EditError(422, "Declare the application's database before connecting this workload.");
    if (edit.enabled) planPlacement(root, state, { target: target.ref, vpc: database.networkId, subnet: target.kind === "lambda" && target.placement.kind === "vpc" && target.placement.subnet === "isolated" ? "isolated" : "private" }, overrides);
  }
  if (edit.connection === "userPool" && (target.role === "agent" || target.role === "tool")) throw new EditError(422, "Agents and tools receive their pool through auth:true. Select the authenticated wrapper in source.");
  const destination = edit.destination ? models.flatMap(model => model.targets).find(target => target.ref === edit.destination) : undefined;
  const expected = edit.connection === "runsTask" ? "task" : edit.connection === "startsWorkflow" ? "workflow" : edit.connection === "invokesAgent" ? "agent" : "lambda";
  if (!simple && (!destination || destination.kind !== expected)) throw new EditError(422, "Choose a compatible declared destination.");
  if (!simple && edit.enabled) { const reason = invocationAccessReason(target, destination!, models); if (reason) throw new EditError(422, reason); }
  for (const origin of target.origins) {
    const files = new SourceFiles(overrides);
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const parsed = parseOrigin(origin), entry = parsed && findEntry(located, parsed);
    if (!entry || !parsed) throw new EditError(422, "This connection's declaration is source-owned.");
    const file = assertWritable(root, toRelative(root, entry.file));
    let text = files.text(file);
    const value = entryValue(files, entry), declaration = value && declarationObject(value, parsed.section, parsed.chain);
    if (!declaration || "unsupported" in declaration) throw new EditError(422, "This computed declaration must be edited in source.");
    const source = files.get(file);
    const keys = simple ? [edit.connection] : ["cloud", "bindings"];
    const position = propertyAt(declaration.object, keys);
    if (["spread", "unsupported"].includes(position.editability.kind) || position.editability.kind === "computed" && !position.property) throw new EditError(422, "This connection uses computed source. Open its declaration to preserve the authored expression.");
    if (simple) {
      const property = position.property;
      if (property && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(property.initializer.kind)) throw new EditError(422, "This setting is computed. Edit it in source.");
      if (property && hasComments(property.getText(source))) throw new EditError(422, "This connection contains comments. Edit it in source to preserve them.");
      if (!edit.enabled && property) text = removeProperty(text, source, position.container, property);
      else if (edit.enabled && property) text = text.slice(0, property.initializer.getStart(source)) + "true" + text.slice(property.initializer.end);
      else if (edit.enabled) text = insertExpression(text, source, position.container, position.missing, "true");
    } else {
      const array = position.property && unwrap(position.property.initializer);
      if (array && (!ts.isArrayLiteralExpression(array) || array.elements.some(ts.isSpreadElement) || hasComments(array.getText(source)))) throw new EditError(422, "This connection list is computed or commented. Edit it in source.");
      const aliases = new Set<string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "aws-studio/config" || statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) aliases.add(`${bindings.name.text}.${edit.connection}`);
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === edit.connection) aliases.add(item.name.text);
      }
      const items = array && ts.isArrayLiteralExpression(array) ? [...array.elements] : [];
      const matches = (item: ts.Expression) => {
        const call = unwrap(item);
        return ts.isCallExpression(call) && aliases.has(call.expression.getText(source)) && call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]!) && call.arguments[0]!.text === destination!.id;
      };
      const exists = items.some(matches);
      if (exists === edit.enabled) throw new EditError(422, edit.enabled ? "This connection already exists." : "This connection is not declared here.");
      if (!edit.enabled && items.filter(matches).length !== 1) throw new EditError(422, "This invocation binding is ambiguous. Remove its exact owning declaration in source.");
      let helper = [...aliases][0];
      const addHelper = !helper;
      if (!helper) {
        const base = `studio${edit.connection[0]!.toUpperCase()}${edit.connection.slice(1)}`;
        helper = base;
        for (let suffix = 2; new RegExp(`\\b${helper}\\b`).test(text); suffix++) helper = `${base}${suffix}`;
      }
      const expression = `${helper}(${JSON.stringify(destination!.id)})`;
      const retained = items.filter(item => edit.enabled || !matches(item)).map(item => item.getText(source));
      if (edit.enabled) retained.push(expression);
      const next = `[${retained.join(", ")}]`;
      if (array) text = text.slice(0, array.getStart(source)) + next + text.slice(array.end);
      else text = insertExpression(text, source, position.container, position.missing, next);
      if (edit.enabled && addHelper) text = `import { ${edit.connection} as ${helper} } from "aws-studio/config";\n${text}`;
    }
    overrides.set(file, text);
  }
}

