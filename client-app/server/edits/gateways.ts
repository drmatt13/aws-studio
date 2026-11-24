import path from "node:path";
import ts from "typescript";
import { locateConfigSource } from "aws-studio/source-index";
import { readGatewayOperation, type GatewayOperation } from "../../shared/gateway-operations";
import type { StudioState } from "../snapshot";
import { SourceFiles, entryValue, findEntry } from "../source";
import { declarationObject, hasComments, propertyAt, unwrap } from "../source/syntax";
import { parseOrigin } from "../model/origin";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { removeProperty } from "./splice";
import { planDeploy } from "./deploy";
import { EditError } from "aws-studio/source/io";

/** Replace only an explicit list owned by the selected declaration; computed source stays source-owned. */
export function planGatewayOperation(root: string, state: StudioState, raw: GatewayOperation, overrides: Map<string, string>): void {
  const edit = readGatewayOperation(raw);
  const models = Object.values(state.snapshot.models);
  const gateway = edit.kind === "agentGateways" ? undefined : models.flatMap(model => model.gateways ?? []).find(item => item.id === edit.gateway && item.protocol === "agentcore");
  const target = edit.kind === "agentGateways" ? models.flatMap(model => model.targets).find(item => item.ref === edit.target && item.kind === "agent") : undefined;
  const origin = target?.origins[0] ?? (gateway?.protocol === "agentcore" ? gateway.origin : undefined);
  if (!origin) throw new EditError(422, "Select an explicit agent or AgentCore Gateway declaration.");
  if (edit.kind === "agentGateways") for (const id of edit.gateways) if (!models.every(model => model.gateways?.some(gateway => gateway.protocol === "agentcore" && gateway.key === id))) throw new EditError(422, "Select existing AgentCore gateways declared in both modes.");
  if (edit.kind === "gatewayTools") for (const id of edit.tools) if (!models.every(model => model.targets.some(target => target.role === "tool" && target.id === id))) throw new EditError(422, "Select existing Lambda tool identifiers declared in both modes.");
  if (edit.kind === "removeGateway") {
    const consumers = models.flatMap(model => model.edges).filter(edge => edge.relation === "usesGateway" && edge.to === edit.gateway);
    if (consumers.length) throw new EditError(422, `Disconnect agents before removing ${edit.gateway}: ${[...new Set(consumers.map(edge => edge.from))].join(", ")}.`);
  }
  if (edit.kind === "gatewayDeploy") {
    // The shared Deploy writer owns condition validation and import handling.
    planDeploy(root, state, { kind: "deploy", target: edit.gateway, value: edit.value }, overrides);
    return;
  }
  const files = new SourceFiles(overrides);
  const parsed = parseOrigin(origin);
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
  const entry = parsed && findEntry(located, parsed), expression = entry && entryValue(files, entry);
  if (!entry || !parsed || !expression) throw new EditError(422, "The selected declaration cannot be located.");
  const declaration = declarationObject(expression, parsed.section, parsed.chain);
  if ("unsupported" in declaration) throw new EditError(422, declaration.unsupported);
  const file = assertWritable(root, toRelative(root, entry.file)), source = files.get(file);
  let text = files.text(file);
  if (edit.kind === "removeGateway") {
    if (!ts.isPropertyAssignment(expression.parent) || !ts.isObjectLiteralExpression(expression.parent.parent) || hasComments(expression.parent.getText(source))) throw new EditError(422, "This Gateway declaration is computed or commented. Remove it in source to preserve its ownership.");
    text = removeProperty(text, source, expression.parent.parent, expression.parent);
  } else {
    const key = edit.kind === "agentGateways" ? "gateways" : "tools";
    const list = edit.kind === "agentGateways" ? edit.gateways : edit.tools;
    const position = propertyAt(declaration.object, [key]);
    if (["spread", "unsupported"].includes(position.editability.kind) || position.editability.kind === "computed" && !position.property) throw new EditError(422, "This connection list is computed. Edit its source expression.");
    const array = position.property && unwrap(position.property.initializer);
    if (array && (!ts.isArrayLiteralExpression(array) || array.elements.some(item => !ts.isStringLiteralLike(item)) || hasComments(array.getText(source)))) throw new EditError(422, "This connection list is computed or commented. Edit it in source.");
    const next = JSON.stringify(list);
    text = array ? text.slice(0, array.getStart(source)) + next + text.slice(array.end) : insertExpression(text, source, position.container, position.missing, next);
  }
  overrides.set(file, text);
}
