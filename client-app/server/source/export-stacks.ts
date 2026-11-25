import { gatewaysOf } from "../../shared/gateways";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROOT_ENV_STACK_OUTPUTS } from "aws-studio/cli/root-env-outputs";
import type { ModelResource, ModeModel, SourceLocation } from "../../shared/model";
import { typeScriptFiles, type CatalogEntrySource, type StackMember } from "./catalog";
import { readConstructorSites, readStackUsage } from "./stack-usage";
import { lineAndColumn, literalKey, parse, unwrap } from "./syntax";
import { toRelative } from "../files";
import { STACK_MEMBER_TAGGING, tagFacts, UNCATALOGED_STACK_TAGGING } from "../model/tags";

export interface ExportStackSource {
  readonly className: string;
  readonly location: SourceLocation;
  readonly outputs: NonNullable<ModelResource["stackOutputs"]>;
  readonly usage?: ModelResource["stackUsage"];
  readonly members?: readonly StackMember[];
}

/** Join class definitions by source as well as name. A project can define an unrelated
 * stack with the same name as one in its installed release. */
export function matchesExportStack(stack: CatalogEntrySource["stack"], exported: ExportStackSource): boolean {
  return stack?.className === exported.className && stack.location?.file === exported.location.file;
}

/** Only outputs on the exporter's public allowlist leave the source reader.
 * Values expose identifier paths only; literals and resolved values are excluded.
 */
export function readExportStacks(repositoryRoot: string, sites = readConstructorSites(repositoryRoot)): readonly ExportStackSource[] {
  const found: ExportStackSource[] = [];
  const mappings: Readonly<Record<string, Readonly<Record<string, string>>>> = ROOT_ENV_STACK_OUTPUTS;
  const files = [...typeScriptFiles(path.join(repositoryRoot, "cdk-app/lib")), ...typeScriptFiles(path.join(repositoryRoot, "node_modules/aws-studio/cdk"))];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("CfnOutput")) continue;
    const source = parse(file, text);
    const namespaces = new Set<string>();
    const constructors = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "aws-cdk-lib" || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "CfnOutput") constructors.add(item.name.text);
    }
    for (const declaration of source.statements) {
      if (!ts.isClassDeclaration(declaration) || !declaration.name || !mappings[declaration.name.text]) continue;
      const className = declaration.name.text;
      const outputs: NonNullable<ModelResource["stackOutputs"]>[number][] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) && node !== declaration) return;
        if (ts.isNewExpression(node)) {
          const expression = node.expression;
          const isOutput = ts.isIdentifier(expression) ? constructors.has(expression.text) : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text) && expression.name.text === "CfnOutput";
          const name = node.arguments?.[1] && unwrap(node.arguments[1]);
          const options = node.arguments?.[2] && unwrap(node.arguments[2]);
          const value = options && ts.isObjectLiteralExpression(options) ? options.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && literalKey(item) === "value")?.initializer : undefined;
          if (isOutput && node.arguments?.[0]?.kind === ts.SyntaxKind.ThisKeyword && name && ts.isStringLiteralLike(name) && mappings[className]![name.text] && value) {
            const start = node.getStart(source);
            // Expose identifier paths only. Literals, calls and templates become
            // an output-name token so authored values cannot enter the snapshot.
            const expression = unwrap(value).getText(source);
            const symbol = /^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression) ? expression.replace(/^this\./, "") : name.text;
            outputs.push({ name: name.text, envName: mappings[className]![name.text]!, symbol, source: { file: toRelative(repositoryRoot, file), ...lineAndColumn(source, start), start, end: node.end } });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration);
      if (!outputs.length) continue;
      const start = declaration.name.getStart(source);
      found.push({ className, location: { file: toRelative(repositoryRoot, file), ...lineAndColumn(source, start), start, end: declaration.name.end }, outputs });
    }
  }
  const catalog = new Map<string, CatalogEntrySource>(found.map(item => [item.location.file + "#" + item.className, { key: item.location, value: item.location, stack: { className: item.className, location: item.location, members: [] } }]));
  const usage = readStackUsage(repositoryRoot, catalog, sites);
  const roles = new Map<string, ExportStackSource[]>();
  for (const item of found) {
    const role = { ...item, usage: usage.get(item.location.file + "#" + item.className) };
    roles.set(item.className, [...(roles.get(item.className) ?? []), role]);
  }
  return [...roles.values()].flatMap(candidates => {
    if (candidates.length === 1) return candidates;
    const referenced = candidates.filter(stack => stack.usage?.status === "referenced");
    if (referenced.length === 1) return referenced;
    const packaged = candidates.filter(stack => stack.location.file.startsWith("node_modules/aws-studio/cdk/"));
    return packaged.length === 1 ? packaged : [];
  });
}

/** Declared framework stack lifecycles, using the model's actual WebSocket AWS lanes. */
function absent(stack: ExportStackSource, model: ModeModel): boolean {
  if (stack.usage?.status === "unreferenced") return true;
  switch (stack.className) {
    case "DevLambdaReplayStack": return model.mode !== "dev";
    case "FrontendWebsiteS3Stack":
    case "HttpApiGatewayStack": return model.mode !== "prod";
    case "WebSocketApiStack": return !gatewaysOf(model).some(gateway => gateway.protocol === "websocket" && gateway.lanes[model.mode]);
    default: return false;
  }
}

/** Reuse catalog identities such as Cognito and RDS; add only missing export stacks. */
export function withExportStacks(model: ModeModel, stacks: readonly ExportStackSource[]): ModeModel {
  const resources = [...model.resources];
  const tagging = { ...model.tagging };
  const exportIds = new Map<string, string>();
  for (const stack of stacks) {
    const existing = resources.findIndex((item) => item.kind === "stack" && item.stackClass === stack.className && item.stackFile === stack.location.file);
    const id = existing >= 0 ? resources[existing]!.id : `framework-stack:${stack.className}`;
    exportIds.set(stack.className, id);
    const item: ModelResource = existing >= 0 ? resources[existing]! : { id, path: [stack.className], kind: "stack", absent: absent(stack, model), stackClass: stack.className, stackFile: stack.location.file, frameworkStack: true, stackUsage: stack.usage };
    const updated = { ...item, frameworkManaged: item.frameworkManaged ?? ("outputs" as const), stackOutputs: stack.outputs };
    if (existing >= 0) resources[existing] = updated; else resources.push(updated);
    // Tagged like any stack; one without a stacks entry yet starts empty.
    if (existing < 0) tagging[id] ??= tagFacts(id, {}, UNCATALOGED_STACK_TAGGING);
    for (const member of stack.members ?? []) {
      const memberId = `${id}.${member.name}`;
      const capability = member.category === "value" ? { kind: "logical" as const, note: "Public stack values have no independently taggable AWS resource." } : STACK_MEMBER_TAGGING;
      tagging[memberId] ??= tagFacts(memberId, {}, capability, { entity: id, tags: tagging[id]?.effective ?? {} });
      if (resources.some(resource => resource.id === memberId)) continue;
      resources.push({ id: memberId, path: [...item.path, member.name], parent: id, kind: "member", absent: item.absent,
        nativeKind: member.category === "construct" ? "resource" : member.category, typeText: member.typeText, memberSource: "class" });
    }
  }
  const replay = resources.find(item => item.id === exportIds.get("DevLambdaReplayStack"));
  const replayBucket = replay && resources.find(item => item.parent === replay.id && item.path.at(-1) === "bucket" && item.nativeKind === "resource");
  const edges = model.edges.filter((edge) => edge.relation !== "localReplay");
  if (replay && replayBucket) for (const target of model.targets) {
    if (target.role !== "event" || target.compute.kind !== "lambda" || !target.compute.localReplay) continue;
    edges.push({
      id: `localReplay:${target.ref}->${replay.id}`, relation: "localReplay", from: target.ref, to: replayBucket.id,
      provenance: "derived", label: "Local replay",
      detail: "localReplay: true captures AWS invocations through the development replay stack for local execution. Production invokes the handler directly.",
    });
  }
  return { ...model, resources, tagging, edges, gateways: gatewaysOf(model).map(gateway => gateway.protocol === "agentcore" ? gateway : ({ ...gateway, stackResource: exportIds.get(gateway.protocol === "http" ? "HttpApiGatewayStack" : "WebSocketApiStack") ?? gateway.stackResource })) };
}
