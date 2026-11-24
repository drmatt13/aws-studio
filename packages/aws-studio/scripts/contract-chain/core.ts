import { createHash } from "node:crypto";
import {
  buildSchema, Kind, lexicographicSortSchema, parse, print, printSchema,
  type DefinitionNode, type TypeDefinitionNode,
} from "graphql";
import type { ChainDiff, GraphQLChainReviewRecord, GraphQLChainReviewRecordV3, PrismaModelShape, SdlSurface } from "./graphql-chain";
import { CONTRACT_FILE, parseDeclaredSchema, type DeclaredPrismaReview } from "./declared-schema";
import { readProofReceipts } from "./proof-core";

export const REVIEW_RECORD_FILE = "graphql-chain.review.json" as const;

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, ordered(entry)]));
  return value;
}

/** Stable identity for semantic data, independent of object insertion order. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(ordered(value));
  if (text === undefined) throw new Error("A fingerprint requires a JSON value.");
  return createHash("sha256").update(text).digest("hex");
}

export function canonicalPrisma(source: string): DeclaredPrismaReview {
  let review: DeclaredPrismaReview | undefined;
  try { parseDeclaredSchema(source, CONTRACT_FILE, value => { review = value; }); }
  catch (error) {
    return { models: {}, diagnostics: [{ code: "PRISMA_READ", file: CONTRACT_FILE,
      message: error instanceof Error ? error.message : "The Prisma contract could not be read." }] };
  }
  return review ?? { models: {}, diagnostics: [{ code: "PRISMA_REVIEW_UNAVAILABLE", file: CONTRACT_FILE,
    message: "The Prisma review projection is unavailable." }] };
}

export function normalizeSdl(text: string): string {
  return printSchema(lexicographicSortSchema(buildSchema(text)));
}

const sdlKinds = {
  [Kind.SCALAR_TYPE_DEFINITION]: "scalar",
  [Kind.OBJECT_TYPE_DEFINITION]: "object",
  [Kind.INTERFACE_TYPE_DEFINITION]: "interface",
  [Kind.UNION_TYPE_DEFINITION]: "union",
  [Kind.ENUM_TYPE_DEFINITION]: "enum",
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: "input",
} as const;

export function sdlSurface(text: string): SdlSurface {
  const schema = lexicographicSortSchema(buildSchema(text));
  const types: Record<string, SdlSurface["types"][string]> = Object.create(null);
  const directives: Record<string, string> = Object.create(null);
  let printedSchema: string | undefined;
  for (const definition of parse(printSchema(schema)).definitions) {
    if (definition.kind === Kind.SCHEMA_DEFINITION) printedSchema = print(definition);
    else if (definition.kind === Kind.DIRECTIVE_DEFINITION) directives[definition.name.value] = print(definition);
    else if (Object.hasOwn(sdlKinds, definition.kind)) {
      const node = definition as TypeDefinitionNode;
      types[node.name.value] = { kind: sdlKinds[node.kind], definition: print(node) };
    }
  }
  // Store explicit roots even when printSchema omits its conventional schema block.
  const roots = [["query", schema.getQueryType()], ["mutation", schema.getMutationType()], ["subscription", schema.getSubscriptionType()]] as const;
  const schemaDefinition = printedSchema ?? `schema {\n${roots.flatMap(([operation, type]) => type ? [`  ${operation}: ${type.name}`] : []).join("\n")}\n}`;
  return { schemaDefinition, types, directives };
}

/** Reconstruct the same printed SDL used for a live schema's fingerprint. */
export function sdlFingerprint(surface: SdlSurface): string {
  return fingerprint(normalizeSdl([surface.schemaDefinition,
    ...Object.values(surface.types).map(type => type.definition), ...Object.values(surface.directives)].join("\n\n")));
}

function diffValue(surface: ChainDiff["surface"], subject: string, path: string, before: unknown, after: unknown): ChainDiff[] {
  if (JSON.stringify(ordered(before)) === JSON.stringify(ordered(after))) return [];
  const render = (value: unknown) => value === undefined ? null : typeof value === "string" ? value : JSON.stringify(ordered(value));
  return [{ surface, subject, path, change: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before: render(before), after: render(after) }];
}

function names(before: object, after: object): string[] { return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(); }

export function diffPrisma(before: Readonly<Record<string, PrismaModelShape>>, after: Readonly<Record<string, PrismaModelShape>>): ChainDiff[] {
  const changes: ChainDiff[] = [];
  for (const model of names(before, after)) {
    const oldModel = before[model], newModel = after[model];
    if (!oldModel || !newModel) {
      changes.push(...diffValue("prisma", model, model, oldModel, newModel));
      continue;
    }
    changes.push(...diffValue("prisma", model, `${model} (access policies)`, oldModel.policies ?? [], newModel.policies ?? []));
    for (const enumeration of names(oldModel.enumPolicies ?? {}, newModel.enumPolicies ?? {})) changes.push(...diffValue("prisma", model, `${model} (enum ${enumeration} access)`, oldModel.enumPolicies?.[enumeration] ?? [], newModel.enumPolicies?.[enumeration] ?? []));
    for (const field of names(oldModel.fields, newModel.fields)) {
      // An access setting is reported on its own, so a changed setting reads as one.
      const shape = (value: PrismaModelShape["fields"][string] | undefined) => {
        if (!value) return value;
        const { access: _access, ...rest } = value;
        return rest;
      };
      const before = oldModel.fields[field], after = newModel.fields[field];
      if (!before || !after) { changes.push(...diffValue("prisma", model, `${model}.${field}`, before, after)); continue; }
      changes.push(...diffValue("prisma", model, `${model}.${field}`, shape(before), shape(after)));
      changes.push(...diffValue("prisma", model, `${model}.${field} (access)`, before.access ?? "managed in app code", after.access ?? "managed in app code"));
    }
    for (const relation of names(oldModel.relations, newModel.relations)) {
      // A row rule is reported on its own, like a field setting.
      const shape = (value: PrismaModelShape["relations"][string] | undefined) => {
        if (!value) return value;
        const { access: _access, ...rest } = value;
        return rest;
      };
      const before = oldModel.relations[relation], after = newModel.relations[relation];
      if (!before || !after) { changes.push(...diffValue("prisma", model, `${model}.${relation}`, before, after)); continue; }
      changes.push(...diffValue("prisma", model, `${model}.${relation}`, shape(before), shape(after)));
      changes.push(...diffValue("prisma", model, `${model}.${relation} (access)`, before.access ?? "no row rule", after.access ?? "no row rule"));
    }
    for (const enumeration of names(oldModel.enums, newModel.enums)) {
      changes.push(...diffValue("prisma", model, `${model} (enum ${enumeration})`, oldModel.enums[enumeration], newModel.enums[enumeration]));
    }
    for (const constraint of names(oldModel.checks ?? {}, newModel.checks ?? {})) {
      changes.push(...diffValue("prisma", model, `${model} (check ${constraint})`, oldModel.checks?.[constraint], newModel.checks?.[constraint]));
    }
  }
  return changes;
}

function typeParts(definition: string): { header: string; members: Record<string, string> } {
  const node = parse(definition).definitions[0] as TypeDefinitionNode;
  let entries: readonly { name: { value: string } }[] = [];
  if ("fields" in node) entries = node.fields ?? [];
  else if (node.kind === Kind.ENUM_TYPE_DEFINITION) entries = node.values ?? [];
  else if (node.kind === Kind.UNION_TYPE_DEFINITION) entries = node.types ?? [];
  const members = Object.fromEntries(entries.map(entry => [entry.name.value, print(entry as DefinitionNode)]));
  const header = node.kind === Kind.ENUM_TYPE_DEFINITION ? print({ ...node, values: [] })
    : node.kind === Kind.UNION_TYPE_DEFINITION ? print({ ...node, types: [] })
      : "fields" in node ? print({ ...node, fields: [] }) : print(node);
  return { header, members };
}

export function diffSdl(before: SdlSurface, after: SdlSurface): ChainDiff[] {
  const changes = diffValue("sdl", "schema", "schema", before.schemaDefinition, after.schemaDefinition);
  for (const name of names(before.types, after.types)) {
    const oldType = before.types[name], newType = after.types[name];
    if (!oldType || !newType || oldType.kind !== newType.kind) {
      changes.push(...diffValue("sdl", name, name, oldType?.definition, newType?.definition));
      continue;
    }
    const oldParts = typeParts(oldType.definition), newParts = typeParts(newType.definition);
    changes.push(...diffValue("sdl", name, name, oldParts.header, newParts.header));
    for (const field of names(oldParts.members, newParts.members)) {
      changes.push(...diffValue("sdl", name, `${name}.${field}`, oldParts.members[field], newParts.members[field]));
    }
  }
  for (const name of names(before.directives, after.directives)) {
    changes.push(...diffValue("sdl", `@${name}`, `@${name}`, before.directives[name], after.directives[name]));
  }
  return changes;
}

const identifier = /^[_A-Za-z][_0-9A-Za-z]*$/;
const modelIdentifier = /^[_A-Za-z][_0-9A-Za-z]*(?:\.[_A-Za-z][_0-9A-Za-z]*)?$/;
function invalidRecord(message: string): never { throw new Error(`Invalid ${REVIEW_RECORD_FILE}: ${message}`); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRecord("expected an object.");
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) invalidRecord("unexpected or missing keys.");
  return result;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 * 1024) invalidRecord("expected a bounded string.");
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 10_000) invalidRecord("expected a bounded array.");
  value.forEach(string);
}
function nullableString(value: unknown): void { if (value !== null) string(value); }
function memberMap(value: unknown, visit: (entry: unknown, key: string) => void, pattern = identifier): void {
  const entries = Object.entries(object(value));
  if (entries.length > 10_000) invalidRecord("too many entries.");
  for (const [key, entry] of entries) {
    if (!pattern.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) invalidRecord("invalid entry name.");
    visit(entry, key);
  }
}
function modelShape(value: unknown): void {
  const model = object(value);
  const optional = ["checks", "policies", "enumPolicies"].filter(key => Object.hasOwn(model, key));
  object(model, ["fields", "relations", "enums", ...optional]);
  memberMap(model.fields, entry => {
    const field = object(entry, Object.hasOwn(object(entry), "access") ? ["type", "nullability", "default", "access"] : ["type", "nullability", "default"]);
    string(field.type); nullableString(field.default);
    if (!["required", "optional"].includes(String(field.nullability))) invalidRecord("invalid field nullability.");
    if (Object.hasOwn(field, "access") && !["server-only", "read-only", "editable"].includes(String(field.access))) invalidRecord("invalid field access.");
  });
  memberMap(model.relations, entry => {
    const relation = object(entry, Object.hasOwn(object(entry), "access")
      ? ["target", "multiplicity", "nullability", "fields", "references", "onDelete", "onUpdate", "access"]
      : ["target", "multiplicity", "nullability", "fields", "references", "onDelete", "onUpdate"]);
    if (Object.hasOwn(relation, "access") && !/^(owner|members|via)(\([^)]*\))?$/.test(String(relation.access))) invalidRecord("invalid relation access.");
    string(relation.target); strings(relation.fields); strings(relation.references);
    nullableString(relation.onDelete); nullableString(relation.onUpdate);
    if (!["required", "optional"].includes(String(relation.nullability)) || !["one", "many"].includes(String(relation.multiplicity))
      || relation.fields.length !== relation.references.length) invalidRecord("invalid relation shape.");
  });
  memberMap(model.enums, entry => strings(entry), modelIdentifier);
  if (Object.hasOwn(model, "checks")) memberMap(model.checks, entry => string(entry));
  if (Object.hasOwn(model, "policies")) strings(model.policies);
  if (Object.hasOwn(model, "enumPolicies")) memberMap(model.enumPolicies, entry => strings(entry), modelIdentifier);
}
function surfaceShape(value: unknown): void {
  const surface = object(value, ["schemaDefinition", "types", "directives"]);
  string(surface.schemaDefinition);
  memberMap(surface.types, (entry, name) => {
    const type = object(entry, ["kind", "definition"]);
    string(type.definition);
    const definitions = parse(type.definition).definitions;
    const node = definitions[0];
    if (definitions.length !== 1 || !node || !Object.hasOwn(sdlKinds, node.kind)
      || (node as TypeDefinitionNode).name.value !== name || sdlKinds[(node as TypeDefinitionNode).kind] !== type.kind) invalidRecord("invalid SDL type definition.");
  });
  memberMap(surface.directives, (entry, name) => {
    string(entry);
    const definitions = parse(entry).definitions;
    if (definitions.length !== 1 || definitions[0]?.kind !== Kind.DIRECTIVE_DEFINITION || definitions[0].name.value !== name) invalidRecord("invalid SDL directive definition.");
  });
  const schema = parse(surface.schemaDefinition).definitions;
  if (schema.length !== 1 || schema[0]?.kind !== Kind.SCHEMA_DEFINITION) invalidRecord("invalid SDL schema definition.");
  // Validate the whole saved surface, including root/field references.
  sdlFingerprint(value as SdlSurface);
}

export function parseReviewRecord(text: string): GraphQLChainReviewRecord {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) invalidRecord("record exceeds its size limit.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { invalidRecord("expected JSON."); }
  const record = object(value);
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) invalidRecord("unsupported version.");
  const v3Keys = Object.hasOwn(record, "ledger") ? ["version", "prisma", "client", "bindings", "proofs", "ledger"] : ["version", "prisma", "client", "bindings", "proofs"];
  object(record, record.version === 1 ? ["version", "prisma", "client"] : record.version === 2 ? ["version", "prisma", "client", "bindings"] : v3Keys);
  if (record.version === 3 && Object.hasOwn(record, "ledger")) {
    const ledger = object(record.ledger);
    for (const [stage, entry] of Object.entries(ledger)) {
      if (!["api", "codegen", "client"].includes(stage)) invalidRecord("unknown ledger stage.");
      const item = object(entry, ["source", "output", "recordedAt"]);
      if (typeof item.source !== "string" || !/^[a-f0-9]{64}$/.test(item.source) || typeof item.output !== "string" || !/^[a-f0-9]{64}$/.test(item.output)
        || typeof item.recordedAt !== "string" || Number.isNaN(Date.parse(item.recordedAt))) invalidRecord("invalid ledger entry.");
    }
  }
  if (record.prisma !== null) {
    const prisma = object(record.prisma, ["models"]);
    memberMap(prisma.models, modelShape, modelIdentifier);
  }
  if (record.client !== null) {
    try { surfaceShape(record.client); }
    catch (error) { invalidRecord(error instanceof Error ? error.message : "invalid SDL surface."); }
  }
  if (record.version === 2 || record.version === 3) {
    const bindings = object(record.bindings, ["api", "client"]);
    const digest = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalidRecord("invalid review binding."); };
    if (bindings.api !== null) digest(bindings.api);
    if (bindings.client !== null) {
      const client = object(bindings.client, ["inputs", "upstream"]);
      digest(client.inputs); digest(client.upstream);
      if (record.client === null) invalidRecord("a client binding requires its reviewed SDL surface.");
    }
  }
  if (record.version === 3) {
    try {
      const proofs = readProofReceipts(record.proofs, "saved");
      const bindings = record.bindings as GraphQLChainReviewRecordV3["bindings"];
      if (proofs.api && (!proofs.api.review || bindings.api !== proofs.api.inputs.implementation)) invalidRecord("API receipt requires its explicit reviewed decision and matching source binding.");
      if (proofs.client && (!proofs.client.review || !record.client || bindings.client?.inputs !== proofs.client.inputs.implementation || bindings.client.upstream !== proofs.client.predecessors.api)) invalidRecord("client receipt requires its explicit reviewed decision, SDL and predecessor bindings.");
    } catch (error) { invalidRecord(error instanceof Error ? error.message : "invalid proof receipts."); }
  }
  return value as GraphQLChainReviewRecord;
}

/** Upgrade only when an explicit scoped acceptance is about to write evidence. */
export function currentReviewRecord(record: GraphQLChainReviewRecord | null): GraphQLChainReviewRecordV3 {
  return record?.version === 3 ? record : { version: 3, prisma: record?.prisma ?? null, client: record?.client ?? null, bindings: record?.version === 2 ? record.bindings : { api: null, client: null }, proofs: {} };
}

export function serializeReviewRecord(record: GraphQLChainReviewRecord): string {
  const text = `${JSON.stringify(ordered(record), null, 2)}\n`;
  parseReviewRecord(text);
  return text;
}
