import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ArrayLiteralAst, GenericBlockDeclarationAst, ModelDeclarationAst, NamespaceDeclarationAst,
  StringLiteralExprAst, parse, type AttributeAst, type AstNode, type ExpressionAst,
} from "@prisma/orm-framework/psl-parser/syntax";
import { accessDirectives, accessOutline, readClientAccess, type RowRule } from "../../database/client-access";
import type { DeclaredSchema, SchemaIndex, SchemaRelation, SchemaRelationAccess, SchemaTable, SourceLocation } from "./declared-schema-model";
import { createHash } from "node:crypto";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
import type { Diagnostic, PrismaModelShape } from "./graphql-chain";

export const CONTRACT_FILE = "packages/database/prisma/contract.prisma";

export interface DeclaredPrismaReview {
  readonly models: Readonly<Record<string, PrismaModelShape>>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Canonical PSL tokens preserve strings while discarding comments and layout. */
function reviewExpression(node: AstNode | undefined, omitOptional = false): string {
  if (!node) return "";
  const tokens = [...node.syntax.tokens()].filter(token => !["Whitespace", "Newline", "Comment"].includes(token.kind)
    && !(omitOptional && token.kind === "Question"));
  return tokens.map((token, index) => {
    const literal = token.kind === "StringLiteral" ? StringLiteralExprAst.cast(token.parent)?.value() : undefined;
    const value = literal === undefined ? token.text : JSON.stringify(literal);
    // Adjacent word tokens must not collapse into a different identifier.
    const previous = tokens[index - 1];
    return previous && /[\w$]$/.test(previous.text) && /^[\w$]/.test(value) ? ` ${value}` : value;
  }).join("");
}

/** Read the authored PSL using Prisma's syntax parser, independently of generated artifacts. */
export function parseDeclaredSchema(text: string, file = CONTRACT_FILE, captureReview?: (review: DeclaredPrismaReview) => void): DeclaredSchema {
  const parsed = parse(text, file);
  const sourceFile = parsed.sources.sourceFileFor(parsed.document.syntax);
  const location = (node: AstNode): SourceLocation => {
    const start = node.syntax.offset;
    const position = sourceFile.positionAt(start);
    return { file, line: position.line + 1, column: position.character + 1, start, end: node.syntax.endOffset };
  };
  const raw = (node: AstNode | undefined) => node ? text.slice(node.syntax.offset, node.syntax.endOffset).trim() : "";
  // Access comes from the compiled `/// @access(…)` directives: a protection on a
  // scalar, and the row rules (with any condition) that follow a relation.
  const access = readClientAccess(text);
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const policiesFor = (block: string): string[] => {
    const enumeration = access.policy.enums[block];
    if (enumeration) return Object.keys(enumeration.grants).length || enumeration.assignable.length !== enumeration.values.length ? [JSON.stringify(canonical({ grants: enumeration.grants, assignable: enumeration.assignable }))] : [];
    const model = access.policy.models[block];
    if (!model) return [];
    const { fields, ...defaults } = model;
    const properties = Object.fromEntries(Object.entries(fields).flatMap(([name, { read, write, role }]) => read || write || role ? [[name, { ...(read ? { read } : {}), ...(write ? { write } : {}), ...(role ? { role } : {}) }]] : []));
    return Object.keys(defaults).length || Object.keys(properties).length ? [JSON.stringify(canonical({ ...defaults, properties }))] : [];
  };
  const outline = accessOutline(text);
  const rowsOf = new Map((accessDirectives(text).length ? outline.models : []).map(({ model, exposed, sentence }) => [model, { exposed, sentence }]));
  const implied = new Set(outline.implied);
  /** An authored protection; keys and clock fields are protected without one. */
  const accessOf = (model: string, node: AstNode) => implied.has(location(node).line) ? undefined : access.settings[model]?.[raw(node).split(/\s/)[0]!];
  const filterText = (rule: RowRule) => {
    if (rule.kind === "owner") return undefined;
    const parts = [...(rule.who ?? []), ...Object.entries(rule.where ?? {}).map(([key, value]) => `${key}: ${typeof value === "object" ? "in" in value ? value.in.join(" | ") : `!${String(value.not)}` : String(value)}`),
      ...Object.entries(rule.own ?? {}).map(([key, value]) => `this.${key}: ${typeof value === "object" ? "in" in value ? value.in.join(" | ") : `!${String(value.not)}` : String(value)}`)];
    return parts.length ? parts.join(", ") : undefined;
  };
  const rulesOf = (model: string, relation: string) => (access.rows.models[model]?.rules ?? []).filter((rule) => ("relation" in rule ? rule.relation : undefined) === relation);
  const ruleOf = (model: string, node: AstNode) => {
    const rule = rulesOf(model, raw(node).split(/\s/)[0]!)[0];
    if (!rule) return undefined;
    const filter = filterText(rule);
    return `${rule.kind}${filter ? `(${filter})` : ""}`;
  };
  const relationAccessOf = (model: string, node: AstNode, side: SchemaRelationAccess["side"]): SchemaRelationAccess[] =>
    rulesOf(model, raw(node).split(/\s/)[0]!).map((rule) => {
      const filter = filterText(rule);
      return { kind: rule.kind, side, field: raw(node).split(/\s/)[0]!, ...(filter ? { filter } : {}), source: location(node) };
    });
  const nameOf = (attribute: AttributeAst) => raw(attribute.name());
  const attribute = (items: Iterable<AttributeAst>, name: string) => [...items].find((item) => nameOf(item) === name);
  const argument = (item: AttributeAst | undefined, name?: string): ExpressionAst | undefined =>
    [...(item?.argList()?.args() ?? [])].find((arg) => arg.name()?.name() === name)?.value();
  const value = (item: AttributeAst | undefined, name?: string) => {
    const expression = argument(item, name);
    return expression instanceof StringLiteralExprAst ? expression.value() : expression ? raw(expression) : undefined;
  };
  const fields = (item: AttributeAst | undefined, name?: string): string[] => {
    const expression = argument(item, name);
    if (!(expression instanceof ArrayLiteralAst)) return [];
    // Indexed fields may include sort/operator options: retain the field identity.
    return [...expression.elements()].map((element) => raw(element).split("(")[0]!.trim());
  };
  const problems = parsed.diagnostics.map((diagnostic) => `${file}:${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
  const tables: SchemaTable[] = [];
  const relations: SchemaRelation[] = [];
  const enums: { name: string; values: string[] }[] = [];
  const models: { node: ModelDeclarationAst; namespace: string }[] = [];
  const reviewModels: Record<string, PrismaModelShape> = Object.create(null);
  const reviewDiagnostics: Diagnostic[] = parsed.diagnostics.map(diagnostic => ({ code: "PRISMA_SYNTAX", message: diagnostic.message,
    file, line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1 }));
  const reviewProblem = (node: AstNode, message: string): void => {
    const source = location(node);
    reviewDiagnostics.push({ code: "PRISMA_REVIEW_UNSUPPORTED", message, file, line: source.line, column: source.column });
  };
  for (const declaration of parsed.document.declarations()) {
    if (declaration instanceof ModelDeclarationAst) models.push({ node: declaration, namespace: "public" });
    else if (declaration instanceof NamespaceDeclarationAst) {
      for (const member of declaration.declarations()) {
        if (member instanceof ModelDeclarationAst) models.push({ node: member, namespace: declaration.name()?.name() ?? "public" });
        else if (member instanceof GenericBlockDeclarationAst && member.keyword()?.text === "enum") {
          enums.push({ name: `${declaration.name()?.name()}.${member.name()?.name()}`, values: [...member.entries()].map((entry) => raw(entry.key())) });
        }
        else if (captureReview) reviewProblem(member, "This declaration is not supported by the contract-chain review projection.");
      }
    } else if (declaration instanceof GenericBlockDeclarationAst && declaration.keyword()?.text === "enum") {
      enums.push({ name: declaration.name()?.name() ?? "", values: [...declaration.entries()].map((entry) => raw(entry.key())) });
    } else {
      problems.push(`Declaration ${raw(declaration).split("\n")[0]} is not displayed as a table.`);
      if (captureReview) reviewProblem(declaration, "This declaration is not supported by the contract-chain review projection.");
    }
  }
  // A recovered syntax tree can omit columns or relationships. Show errors instead of a partial diagram.
  if (parsed.diagnostics.length) {
    captureReview?.({ models: reviewModels, diagnostics: reviewDiagnostics });
    return { file, hash: sha256(text), tables: [], relations: [], enums: [], problems };
  }
  const tableId = (namespace: string, model: string) => `schema:${namespace}.${model}`;
  const reviewModelId = (namespace: string, model: string) => namespace === "public" ? model : `${namespace}.${model}`;
  const sorted = <T>(entries: readonly (readonly [string, T])[]): Record<string, T> => Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  for (const { node, namespace } of models) {
    const model = node.name()?.name();
    if (!model) continue;
    const attributes = [...node.attributes()];
    const id = tableId(namespace, model);
    const indexes: SchemaIndex[] = [];
    if (captureReview) {
      const shapeFields: Record<string, PrismaModelShape["fields"][string]> = Object.create(null);
      const shapeRelations: Record<string, PrismaModelShape["relations"][string]> = Object.create(null);
      const shapeEnums: Record<string, readonly string[]> = Object.create(null);
      const shapeChecks: Record<string, string> = Object.create(null);
      const seenFields = new Set<string>();
      if (Object.hasOwn(reviewModels, reviewModelId(namespace, model))) reviewProblem(node, `Duplicate model ${model} cannot be projected for review.`);
      for (const item of attributes) if (!["id", "unique", "index", "map", "check"].includes(nameOf(item))) {
        reviewProblem(item, `Model annotation ${nameOf(item)} is not supported by the contract-chain review projection.`);
      }
      for (const item of attributes.filter(item => nameOf(item) === "check")) {
        const expression = argument(item, "expression"), named = argument(item, "name");
        if (!(expression instanceof StringLiteralExprAst) || named && !(named instanceof StringLiteralExprAst)) {
          reviewProblem(item, "A CHECK constraint requires a literal SQL expression and an optional literal name.");
          continue;
        }
        const sql = expression.value();
        const explicitName = named instanceof StringLiteralExprAst ? named.value() : undefined;
        if (typeof sql !== "string" || sql.length > 64 * 1024 || named && typeof explicitName !== "string") {
          reviewProblem(item, "A CHECK constraint must contain a bounded, valid string literal.");
          continue;
        }
        const key = explicitName ?? `check_${sha256(sql)}`;
        if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(key) || Object.hasOwn(shapeChecks, key)) {
          reviewProblem(item, "A CHECK constraint name must be a unique review identifier.");
          continue;
        }
        shapeChecks[key] = sql;
      }
      for (const field of node.fields()) {
        const name = field.name()?.name(), type = field.typeAnnotation();
        if (!name || !type) { reviewProblem(field, "A model field could not be projected for review."); continue; }
        if (seenFields.has(name)) reviewProblem(field, `Duplicate field ${model}.${name} cannot be projected for review.`);
        seenFields.add(name);
        const attrs = [...field.attributes()];
        for (const item of attrs) if (!["id", "unique", "default", "map", "relation"].includes(nameOf(item))) {
          reviewProblem(item, `Field annotation ${nameOf(item)} is not supported by the contract-chain review projection.`);
        }
        const targetName = reviewExpression(type.name());
        const qualifiedTarget = targetName.startsWith("public.") ? targetName.slice(7) : targetName.includes(".") ? targetName : reviewModelId(namespace, targetName);
        const target = models.find(candidate => reviewModelId(candidate.namespace, candidate.node.name()?.name() ?? "") === qualifiedTarget);
        const relation = attribute(attrs, "relation");
        if (relation || target) {
          const localFields = fields(relation, "fields"), references = fields(relation, "references");
          for (const key of ["fields", "references"]) {
            const expression = argument(relation, key);
            if (expression && (!(expression instanceof ArrayLiteralAst)
              || [...expression.elements()].some(element => !/^[_A-Za-z][_0-9A-Za-z]*$/.test(reviewExpression(element))))) {
              reviewProblem(field, `${model}.${name} uses an unsupported ${key} expression.`);
            }
          }
          if (!target || references.length !== localFields.length || localFields.some(local => ![...node.fields()].some(item => item.name()?.name() === local))
            || references.some(reference => ![...target.node.fields()].some(item => item.name()?.name() === reference))) {
            reviewProblem(field, `${model}.${name} has an unresolved relation target or foreign-key mapping.`);
          }
          shapeRelations[name] = { target: qualifiedTarget, multiplicity: type.isList() ? "many" : "one",
            nullability: type.isOptional() ? "optional" : "required", fields: localFields, references,
            onDelete: reviewExpression(argument(relation, "onDelete")) || (localFields.length ? "Restrict" : null),
            onUpdate: reviewExpression(argument(relation, "onUpdate")) || (localFields.length ? "Restrict" : null),
            ...(ruleOf(model, field) ? { access: ruleOf(model, field) } : {}) };
        } else {
          const access = accessOf(model, field);
          shapeFields[name] = { type: reviewExpression(type, true), nullability: type.isOptional() ? "optional" : "required",
            default: argument(attribute(attrs, "default")) ? reviewExpression(argument(attribute(attrs, "default"))) : null,
            ...(access ? { access } : {}) };
          const enumName = enums.some(item => item.name === `${namespace}.${targetName}`) ? `${namespace}.${targetName}` : targetName;
          const enumeration = enums.find(item => item.name === enumName);
          if (enumeration) shapeEnums[enumName] = [...enumeration.values].sort();
        }
      }
      reviewModels[reviewModelId(namespace, model)] = {
        ...(policiesFor(model).length ? { policies: policiesFor(model) } : {}),
        ...(Object.keys(shapeEnums).some((name) => policiesFor(name).length) ? { enumPolicies: Object.fromEntries(Object.keys(shapeEnums).filter((name) => policiesFor(name).length).map((name) => [name, policiesFor(name)])) } : {}),
        fields: sorted(Object.entries(shapeFields)), relations: sorted(Object.entries(shapeRelations)), enums: sorted(Object.entries(shapeEnums)),
        ...(Object.keys(shapeChecks).length ? { checks: sorted(Object.entries(shapeChecks)) } : {}) };
    }
    for (const item of attributes) {
      const name = nameOf(item);
      if (name !== "id" && name !== "index" && name !== "unique") {
        if (name !== "map") problems.push(`${model}: ${raw(item)} is preserved in source at line ${location(item).line}; this annotation is not drawn in the diagram.`);
        continue;
      }
      if (!fields(item).length) problems.push(`${model}: ${raw(item)} uses an expression or another index shape without projected field identities. Inspect source at line ${location(item).line}.`);
      indexes.push({
        name: value(item, "map") ?? value(item, "name"),
        kind: name === "id" ? "primary" : name === "unique" || value(item, "unique") === "true" ? "unique" : "index",
        fields: fields(item), predicate: value(item, "where"), declaration: raw(item), source: location(item),
      });
    }
    const columns = [];
    for (const field of node.fields()) {
      const name = field.name()?.name();
      const type = field.typeAnnotation();
      if (!name || !type) continue;
      const attrs = [...field.attributes()];
      for (const item of attrs) if (!["id", "unique", "default", "map", "relation"].includes(nameOf(item))) {
        problems.push(`${model}.${name}: ${raw(item)} is preserved in source at line ${location(item).line}; this field annotation is not drawn in the diagram.`);
      }
      const relation = attribute(attrs, "relation");
      if (relation) {
        const localFields = fields(relation, "fields");
        const references = fields(relation, "references");
        // Back references carry no FK; the owning side supplies the connector.
        if (!localFields.length) continue;
        const target = raw(type.name());
        const targetId = target.includes(":") ? undefined : target.includes(".") ? `schema:${target}` : tableId(namespace, target);
        if (!targetId || !models.some((candidate) => tableId(candidate.namespace, candidate.node.name()?.name() ?? "") === targetId)) {
          problems.push(`${model}.${name}: related model ${target} is outside this contract diagram.`);
          continue;
        }
        const targetModel = models.find((candidate) => tableId(candidate.namespace, candidate.node.name()?.name() ?? "") === targetId)!;
        const targetNode = targetModel.node;
        if (references.length !== localFields.length || localFields.some((name) => ![...node.fields()].some((field) => field.name()?.name() === name)) || references.some((name) => ![...targetNode.fields()].some((field) => field.name()?.name() === name))) {
          problems.push(`${model}.${name}: foreign-key fields or references are unresolved.`);
          continue;
        }
        const relationName = value(relation, "name") ?? value(relation);
        const inverseFields = [...targetNode.fields()].filter((candidate) => {
          if (candidate === field) return false;
          const candidateTarget = raw(candidate.typeAnnotation()?.name());
          const candidateId = candidateTarget.includes(".") ? `schema:${candidateTarget}` : tableId(targetModel.namespace, candidateTarget);
          const inverse = attribute(candidate.attributes(), "relation");
          return candidateId === id && !fields(inverse, "fields").length && (value(inverse, "name") ?? value(inverse)) === relationName;
        });
        // A named pair is exact; an unnamed pair is safe only with a unique
        // inverse. Never borrow rules from another relationship between models.
        const access = [...relationAccessOf(model, field, "from"),
          ...(inverseFields.length === 1 ? relationAccessOf(targetModel.node.name()?.name() ?? "", inverseFields[0]!, "to") : [])];
        relations.push({ id: `${id}.${name}`, name, from: id, to: targetId, fields: localFields, references,
          cardinality: "N:1", nullable: type.isOptional(), onDelete: value(relation, "onDelete") ?? "Restrict",
          onUpdate: value(relation, "onUpdate") ?? "Restrict", source: location(field), ...(access.length ? { access } : {}) });
        continue;
      }
      for (const kind of ["id", "unique"] as const) {
        const item = attribute(attrs, kind);
        if (item) indexes.push({ name: value(item, "map") ?? value(item, "name"), kind: kind === "id" ? "primary" : "unique", fields: [name], declaration: raw(item), source: location(item) });
      }
      const access = accessOf(model, field);
      columns.push({ name, column: value(attribute(attrs, "map")) ?? name, type: raw(type), nullable: type.isOptional(),
        primaryKey: false, unique: false, default: value(attribute(attrs, "default")), source: location(field), ...(access ? { access } : {}) });
    }
    tables.push({ id, model, namespace, table: value(attribute(attributes, "map")) ?? model,
      columns: columns.map((column) => ({ ...column,
        primaryKey: indexes.some((index) => index.kind === "primary" && index.fields.includes(column.name)),
        unique: indexes.some((index) => index.kind !== "index" && !index.predicate && index.fields.length === 1 && index.fields[0] === column.name),
      })), indexes, source: location(node), ...(rowsOf.has(model) ? { rows: rowsOf.get(model)! } : {}) });
  }
  captureReview?.({ models: sorted(Object.entries(reviewModels)), diagnostics: reviewDiagnostics });
  return { file, hash: sha256(text), tables, enums, problems,
    relations: relations.map((relation) => {
      const table = tables.find((table) => table.id === relation.from)!;
      return { ...relation,
        nullable: table.columns.some((column) => relation.fields.includes(column.name) && column.nullable),
        cardinality: table.indexes.some((index) => index.kind !== "index" && !index.predicate && index.fields.length > 0 && index.fields.every((field) => relation.fields.includes(field))) ? "1:1" : "N:1",
      };
    }),
  };
}

export function readDeclaredSchema(root: string): DeclaredSchema {
  try { return parseDeclaredSchema(readFileSync(path.join(root, CONTRACT_FILE), "utf8")); }
  catch { return { file: CONTRACT_FILE, hash: "", tables: [], relations: [], enums: [], problems: [`Cannot read ${CONTRACT_FILE}.`] }; }
}
