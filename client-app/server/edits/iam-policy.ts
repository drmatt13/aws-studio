import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locateConfigSource } from "aws-studio/source-index";
import { readIamPolicyEdit, readPermissionStatement, permissionStatementKey, type IamPolicyEdit, type PermissionStatementInput } from "../../shared/permission-rules";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { declarationObject, expressionAt, parse, propertyAt, unwrap } from "../source/syntax";
import { frameworkExport } from "../source/factories";
import { discoverPolicyRules, policyRuleId } from "../source/permission-rules";
import { resourceAlias, addResourceImport } from "./resource-alias";
import { EditError } from "aws-studio/source/io";
import { replaceWithComments } from "./comments";
import { removeElement } from "./source-cleanup";

export function validatePermissionStatement(state: StudioState, raw: PermissionStatementInput): PermissionStatementInput {
  const input = readPermissionStatement(raw), models = Object.values(state.snapshot.models);
  for (const resource of input.resources) {
    if (resource.kind === "target") {
      if (!models.some(model => model.targets.some(target => target.ref === resource.target))) throw new EditError(422, "Choose a declared workload ARN reference.");
    } else if (resource.kind === "catalog") {
      const capability = state.snapshot.source.permissionCapabilities?.find(item => item.resource === resource.resource);
      if (!capability?.attributes?.includes(resource.attribute) || !/Arn$/i.test(resource.attribute)) throw new EditError(422, "Choose a public typed ARN attribute from the native stack catalog.");
    }
  }
  return input;
}

/** Replace exactly the reviewed literal owner; shared declarations retain all consumers. */
export function planIamPolicy(root: string, state: StudioState, raw: IamPolicyEdit, overrides: Map<string, string>): void {
  const edit = readIamPolicyEdit(raw), target = Object.values(state.snapshot.models).flatMap(model => model.targets).find(target => target.ref === edit.target);
  if (!target || target.kind === "workflow") throw new EditError(422, "Select a compute workload's execution-role policy.");
  const statement = edit.statement && validatePermissionStatement(state, edit.statement);
  const owner = edit.rule && state.snapshot.source.policyRules?.find(rule => rule.id === edit.rule);
  const affected = owner ? owner.consumers : [edit.target];
  let file: string, text: string, start: number | undefined, end: number | undefined, insertion: ReturnType<typeof propertyAt> | undefined;
  if (edit.operation !== "add") {
    const rule = state.snapshot.source.policyRules?.find(rule => rule.id === edit.rule);
    if (!rule || !rule.consumers.includes(edit.target) || !rule.location) throw new EditError(409, "This policy rule changed. Refresh and select its owning declaration.");
    if (!rule.writable) throw new EditError(422, rule.reason ?? "This computed IAM rule remains source-owned.");
    file = assertWritable(root, rule.location.file);
    const before = readFileSync(file, "utf8"), original = before.slice(rule.location.start, rule.location.end);
    if (policyRuleId(rule.location, original) !== rule.id) throw new EditError(409, "The owning IAM rule changed. Review its current source.");
    text = overrides.get(file) ?? before;
    let offset = rule.location.start;
    if (text.slice(offset, offset + original.length) !== original) { offset = text.indexOf(original); if (offset < 0 || text.indexOf(original, offset + 1) >= 0) throw new EditError(409, "The IAM owner moved ambiguously in this draft. Review shared policy changes separately."); }
    const source = parse(file, text), node = expressionAt(source, offset, offset + original.length);
    if (!node || !ts.isObjectLiteralExpression(node) || !ts.isArrayLiteralExpression(node.parent)) throw new EditError(422, "This IAM policy array is computed. Open its owning declaration.");
    if (edit.operation === "remove") {
      overrides.set(file, removeElement(text, node.parent, node, source));
      return;
    }
    start = node.getStart(source); end = node.end;
  } else {
    const files = new SourceFiles(overrides), located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    if (target.origins.length !== 1) throw new EditError(422, "This workload has multiple declarations. Add its IAM policy in the owning source.");
    const parsed = parseOrigin(target.origins[0]!), entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry), declaration = parsed && value && declarationObject(value, parsed.section, parsed.chain);
    if (!entry || !declaration || "unsupported" in declaration) throw new EditError(422, "This workload declaration is computed. Open its source.");
    file = assertWritable(root, toRelative(root, entry.file)); text = files.text(file);
    insertion = propertyAt(declaration.object, ["cloud", "access"]);
    if (["unsupported", "spread"].includes(insertion.editability.kind) || insertion.editability.kind === "computed" && !insertion.property) throw new EditError(422, "This access declaration is computed. Open its source.");
  }
  const source = parse(file, text), located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: new SourceFiles(overrides).host() });
  const current = new Map(overrides); current.set(file, text);
  const key = permissionStatementKey(statement!);
  for (const model of Object.values(state.snapshot.models)) {
    const rules = discoverPolicyRules(root, model, located, file => current.get(file) ?? readFileSync(file, "utf8"));
    if (rules.some(rule => rule.consumers.some(consumer => affected.includes(consumer)) && !(start !== undefined && rule.location?.file === toRelative(root, file) && rule.location.start === start && rule.location.end === end) && permissionStatementKey(rule.statement) === key)) throw new EditError(422, "This exact IAM policy already exists for an affected consumer.");
  }
  let addCatalog = false, catalogAlias = "", addTargetHelper = false, targetHelper = "";
  if (statement!.resources.some(resource => resource.kind === "catalog")) { const found = resourceAlias(root, file, source, text, "stacks", located); catalogAlias = found.alias; addCatalog = !found.imported; }
  if (statement!.resources.some(resource => resource.kind === "target")) {
    for (const item of source.statements) if (ts.isImportDeclaration(item) && !item.importClause?.isTypeOnly && item.importClause?.namedBindings) {
      const bindings = item.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) for (const binding of bindings.elements) if (!binding.isTypeOnly && frameworkExport(source, binding.name) === "targetArn") targetHelper = binding.name.text;
      if (ts.isNamespaceImport(bindings)) { const expression = ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(bindings.name.text), "targetArn"); if (frameworkExport(source, expression) === "targetArn") targetHelper = `${bindings.name.text}.targetArn`; }
    }
    if (!targetHelper) { targetHelper = "studioTargetArn"; for (let suffix = 2; new RegExp(`\\b${targetHelper}\\b`).test(text); suffix++) targetHelper = `studioTargetArn${suffix}`; addTargetHelper = true; }
  }
  const resources = statement!.resources.map(resource => {
    if (resource.kind === "literal") return JSON.stringify(resource.value);
    const reference = resource.kind === "target" ? `${targetHelper}(${JSON.stringify(resource.target)})` : `${catalogAlias}${resource.resource.slice("resource:".length).split(".").map(part => `[${JSON.stringify(part)}]`).join("")}[${JSON.stringify(resource.attribute)}]`;
    return resource.suffix ? `{ resource: ${reference}, suffix: ${JSON.stringify(resource.suffix)} }` : reference;
  });
  const expression = `{ actions: ${JSON.stringify(statement!.actions)}, resources: [${resources.join(", ")}]${statement!.effect ? `, effect: ${JSON.stringify(statement!.effect)}` : ""}${statement!.conditions ? `, conditions: ${JSON.stringify(statement!.conditions)}` : ""} }`;
  if (start !== undefined) text = replaceWithComments(text, source, expressionAt(source, start, end!)!, expression);
  else if (insertion!.property) {
    const value = unwrap(insertion!.property.initializer);
    if (ts.isArrayLiteralExpression(value)) { const at = value.end - 1; text = text.slice(0, at) + `${value.elements.length && !value.elements.hasTrailingComma ? "," : ""} ${expression}` + text.slice(at); }
    else if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) text = text.slice(0, value.getStart()) + `[...${value.getText()}, ${expression}]` + text.slice(value.end);
    else throw new EditError(422, "This access list is computed. Add a literal policy in its owning source.");
  } else text = insertExpression(text, source, insertion!.container, insertion!.missing, `[${expression}]`);
  if (addCatalog) text = addResourceImport(root, file, text, catalogAlias, "stacks", located);
  if (addTargetHelper) text = `import { targetArn as ${targetHelper} } from "aws-studio/config";\n${text}`;
  overrides.set(file, text);
}
