import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  locateConfigSource,
  type ConfigSourceHost,
  type LocatedConfigSource,
  type LocatedSectionEntry,
} from "aws-studio/source-index";
import type { CdkLinkIndex, Editability, EntitySource, FieldFact, ModeModel, SourceIndex, SourceLocation } from "../../shared/model";
import { fieldById } from "../edits/fields";
import { parseOrigin, type ParsedOrigin } from "../model/origin";
import { readConfiguredCatalog, readResourceLinks, type CatalogEntrySource } from "./catalog";
import { descriptorFactory } from "./factories";
import { readConstructorSites, readStackUsage } from "./stack-usage";
import { readExportStacks, type ExportStackSource } from "./export-stacks";
import { scanCdkLinks } from "./cdk-links";
import { discoverCapabilities } from "./capabilities";
import { discoverPolicyRules } from "./permission-rules";
import { locateManagedDatabase } from "./database";
import { declarationObject, expressionAt, findProperty, lineAndColumn, literalValue, parse, propertyAt, unwrap, hasComments } from "./syntax";
import { stackTagLocation, tagEditability } from "./tags";

/**
 * Where every entity was written, and what the studio may change in it.
 *
 * Built on the framework's own locator (scripts/config-source.ts), which
 * follows framework.config.ts into each section module exactly as
 * `framework:check` does. Property-level answers come from the entry's object
 * literal, and every editable literal is checked against the value the
 * framework evaluated: if the source and the evaluated config disagree, the
 * studio does not trust its reading of the source and refuses to edit.
 */

export interface BuiltSourceIndex {
  readonly index: SourceIndex;
  readonly catalog: ReadonlyMap<string, CatalogEntrySource>;
  readonly exportStacks: readonly ExportStackSource[];
  readonly located?: LocatedConfigSource;
}

/** Parsed source files, read once per index (or from an overlay, when planning an edit). */
export class SourceFiles {
  private readonly parsed = new Map<string, ts.SourceFile>();
  constructor(private readonly overlay: ReadonlyMap<string, string> = new Map()) {}

  withText(file: string, text: string): SourceFiles {
    return new SourceFiles(new Map([...this.overlay, [path.resolve(file), text]]));
  }

  text(file: string): string {
    return this.overlay.get(path.resolve(file)) ?? readFileSync(file, "utf8");
  }

  get(file: string): ts.SourceFile {
    const key = path.resolve(file);
    let sourceFile = this.parsed.get(key);
    if (!sourceFile) {
      sourceFile = parse(file, this.text(file));
      this.parsed.set(key, sourceFile);
    }
    return sourceFile;
  }

  host(): ConfigSourceHost {
    return {
      readFile: (file) => this.text(file),
      exists: (file) => this.overlay.has(path.resolve(file)) || ts.sys.fileExists(file),
    };
  }
}

function relative(repositoryRoot: string, file: string): string {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

function location(repositoryRoot: string, sourceFile: ts.SourceFile, start: number, end: number): SourceLocation {
  return { file: relative(repositoryRoot, sourceFile.fileName), ...lineAndColumn(sourceFile, start), start, end };
}

type LocatedDeclaration = Pick<LocatedSectionEntry, "file" | "key" | "keySpan" | "valueSpan">;

export function findEntry(located: LocatedConfigSource, origin: ParsedOrigin): LocatedDeclaration | undefined {
  if (origin.section === "defaults") {
    const property = located.properties.defaults;
    return property ? { file: property.file, key: "defaults", keySpan: property.span, valueSpan: property.span } : undefined;
  }
  return located.sections[origin.section].find((entry) => entry.key === origin.key);
}

/** The value expression of a located entry, parsed. */
export function entryValue(files: SourceFiles, entry: LocatedDeclaration): ts.Expression | undefined {
  return expressionAt(files.get(entry.file), entry.valueSpan.start, entry.valueSpan.end);
}

/** Where an origin was written: the entry itself, or a property below it. */
function locateOrigin(
  repositoryRoot: string,
  files: SourceFiles,
  located: LocatedConfigSource,
  origin: string,
): EntitySource | undefined {
  const parsed = parseOrigin(origin);
  if (!parsed) return undefined;
  const entry = findEntry(located, parsed);
  if (!entry) return undefined;
  const sourceFile = files.get(entry.file);
  let key = location(repositoryRoot, sourceFile, entry.keySpan.start, entry.keySpan.end);
  let value = location(repositoryRoot, sourceFile, entry.valueSpan.start, entry.valueSpan.end);
  let object = entryValue(files, entry);
  for (const link of parsed.chain) {
    const inner = object && ts.isObjectLiteralExpression(object) ? findProperty(object, link).property : undefined;
    if (!inner || !ts.isPropertyAssignment(inner)) break;
    key = location(repositoryRoot, sourceFile, inner.name.getStart(sourceFile), inner.name.end);
    value = location(repositoryRoot, sourceFile, inner.initializer.getStart(sourceFile), inner.initializer.end);
    object = inner.initializer;
  }
  return { origin, key, value };
}

function sameValue(source: string | number | boolean, evaluated: FieldFact["authored"]): boolean {
  return evaluated !== undefined && evaluated !== null && source === evaluated;
}

/** What the source allows for one field of one target, cross-checked against the evaluated value. */
export function fieldEditability(
  files: SourceFiles,
  located: LocatedConfigSource,
  origin: string,
  fact: FieldFact,
): Editability {
  if (fact.blocked) return { kind: "unsupported", reason: fact.blocked };
  const definition = fieldById(fact.field);
  if (!definition) {
    return { kind: "unsupported", reason: `This Studio server has not loaded the edit control for ${fact.field}. Restart Studio to load updated settings.` };
  }
  const parsed = parseOrigin(origin);
  const entry = parsed ? findEntry(located, parsed) : undefined;
  const value = entry ? entryValue(files, entry) : undefined;
  if (!parsed || !entry || !value) {
    return { kind: "unsupported", reason: `${origin} could not be found in source.` };
  }
  const declaration = declarationObject(value, parsed.section, parsed.chain);
  if ("unsupported" in declaration) return { kind: "unsupported", reason: declaration.unsupported };
  const position = propertyAt(declaration.object, definition.path);
  const editability = position.editability;
  if (editability.kind === "literal") {
    const written = position.property ? literalValue(position.property.initializer) : undefined;
    if (!written || !sameValue(written.value, fact.authored)) {
      return {
        kind: "unsupported",
        reason: `The source writes ${editability.text}, but the evaluated config holds ${JSON.stringify(fact.authored)}. Something between them changes it, so the studio leaves it alone.`,
      };
    }
  }
  if (editability.kind === "absent" && fact.authored !== undefined) {
    return {
      kind: "unsupported",
      reason: `The source does not write ${definition.path.join(".")}, but the evaluated config holds ${JSON.stringify(fact.authored)}.`,
    };
  }
  return editability;
}

function literalListEditability(object: ts.ObjectLiteralExpression, key: string, expected: readonly string[]): Editability {
  const position = propertyAt(object, [key]);
  if (!position.property) return position.editability.kind === "absent" && !expected.length ? { kind: "absent" } : { kind: "unsupported", reason: "This list is supplied by computed source. Edit its owning expression." };
  const list = unwrap(position.property.initializer);
  if (position.editability.kind === "spread" || !ts.isArrayLiteralExpression(list) || list.elements.some(item => !ts.isStringLiteralLike(item)) || hasComments(list.getText())) return { kind: "unsupported", reason: "This list is computed or commented. Edit it in source to preserve its ownership." };
  const ids = list.elements.map(item => (item as ts.StringLiteralLike).text);
  return JSON.stringify(ids) === JSON.stringify(expected) ? { kind: "literal", text: list.getText() } : { kind: "unsupported", reason: "The source list differs from its evaluated declaration. Edit its owning expression." };
}

/** The source index for one evaluated model. */
export function buildSourceIndex(
  repositoryRoot: string,
  model: ModeModel,
  files: SourceFiles = new SourceFiles(),
): BuiltSourceIndex {
  const problems: string[] = [];
  const entities: Record<string, EntitySource> = {};
  const editability: Record<string, Record<string, Editability>> = {};
  const catalogFacts: Record<string, { condition?: string; stackClass?: string; stackLocation?: SourceLocation; tagLocation?: SourceLocation }> = {};
  let located: LocatedConfigSource | undefined;
  try {
    located = locateConfigSource(path.join(repositoryRoot, "framework.config.ts"), { repositoryRoot, host: files.host() });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (located) {
    const database = locateManagedDatabase(repositoryRoot, files);
    if (database) {
      const at = { file: relative(repositoryRoot, database.file), line: database.line, column: database.column, start: database.span.start, end: database.span.end };
      entities[`database:${database.id}`] = { origin: `database.${database.id}`, key: at, value: at };
    }
    for (const network of located.networks) {
      const at = { file: relative(repositoryRoot, network.file), line: network.line, column: network.column, start: network.span.start, end: network.span.end };
      entities[`island:vpc:${network.id}`] = { origin: `networks.${network.id}`, key: at, value: at };
    }
    for (const target of model.targets) {
      const origin = target.origins[0];
      const source = origin ? locateOrigin(repositoryRoot, files, located, origin) : undefined;
      if (source) entities[target.ref] = source;
      else problems.push(`${target.ref} (${origin ?? "no origin"}) was not found in source.`);
      editability[target.ref] = Object.fromEntries(
        (model.fields[target.ref] ?? []).map((fact) => [
          fact.field,
          origin ? fieldEditability(files, located!, origin, fact) : { kind: "unsupported", reason: "No declaration origin." },
        ]),
      );
      if (target.compute.kind === "agent" && origin) {
        const parsed = parseOrigin(origin), entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry);
        const declaration = value && parsed && declarationObject(value, parsed.section, parsed.chain);
        if (declaration && !("unsupported" in declaration)) editability[target.ref]!.gateways = literalListEditability(declaration.object, "gateways", target.compute.gateways);
      }
    }
    for (const gateway of model.gateways ?? []) {
      if (gateway.protocol !== "agentcore") continue;
      const source = locateOrigin(repositoryRoot, files, located, gateway.origin);
      if (source) entities[gateway.id] = source;
      const parsed = parseOrigin(gateway.origin), entry = parsed && findEntry(located, parsed), value = entry && entryValue(files, entry);
      const declaration = value && parsed && declarationObject(value, parsed.section, parsed.chain);
      if (declaration && !("unsupported" in declaration)) editability[gateway.id] = { deploy: propertyAt(declaration.object, ["deploy"]).editability, tools: literalListEditability(declaration.object, "tools", gateway.tools) };
    }
    for (const route of model.routes) {
      const source = locateOrigin(repositoryRoot, files, located, route.origin);
      if (source) entities[route.id] = source;
    }
    for (const group of model.defaults ?? []) {
      const source = locateOrigin(repositoryRoot, files, located, group.origin);
      if (source) entities[group.ref] = source;
      editability[group.ref] = Object.fromEntries((model.fields[group.ref] ?? []).map((fact) => [fact.field, fieldEditability(files, located!, group.origin, fact)]));
    }
  }

  let catalog = new Map<string, CatalogEntrySource>();
  if (located) {
    try {
      catalog = readConfiguredCatalog(repositoryRoot, located, (file) => files.text(file));
    } catch (error) {
      problems.push(`The resource catalog could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let triggerCapabilities: SourceIndex["triggerCapabilities"] = [];
  let permissionCapabilities: SourceIndex["permissionCapabilities"] = [];
  let capabilityFiles: SourceIndex["capabilityFiles"] = {};
  // Cataloged and framework-owned stacks share one type-aware member discovery.
  const sites = readConstructorSites(repositoryRoot);
  let exportStacks: readonly ExportStackSource[] = [];
  try { exportStacks = readExportStacks(repositoryRoot, sites); }
  catch (error) { problems.push(`Root environment export stacks could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  if (exportStacks.length || [...catalog.values()].some(entry => {
    const source = files.get(path.join(repositoryRoot, entry.value.file));
    const value = expressionAt(source, entry.value.start, entry.value.end);
    let native = !!entry.stack;
    const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && ["stack", "cdk"].includes(descriptorFactory(source, node) ?? "")) native = true; ts.forEachChild(node, visit); };
    if (value) visit(value);
    return native;
  })) {
    try {
      const discovered = discoverCapabilities(repositoryRoot, catalog, model.triggerAdapters ?? [], exportStacks);
      catalog = new Map(discovered.catalog);
      triggerCapabilities = discovered.capabilities;
      permissionCapabilities = discovered.permissionCapabilities;
      capabilityFiles = discovered.files;
      exportStacks = discovered.exportStacks;
    } catch (error) { problems.push(`Native resource capabilities could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // One walk of the CDK app's imports answers both the catalog and the export stacks.
  const stackUsage = readStackUsage(repositoryRoot, catalog, sites);
  for (const [key, entry] of catalog) catalog.set(key, { ...entry, stackUsage: entry.stackUsage ?? stackUsage.get(key) });
  for (const [catalogPath, entry] of catalog) {
    const id = `resource:${catalogPath}`;
    entities[id] = { origin: `resources.${catalogPath}`, key: entry.key, value: entry.value };
    catalogFacts[id] = {
      ...(entry.condition ? { condition: entry.condition } : {}),
      ...(entry.stack ? { stackClass: entry.stack.className } : {}),
      ...(entry.stack?.location ? { stackLocation: entry.stack.location } : {}),
    };
    for (const member of entry.stack?.members ?? []) {
      entities[`resource:${catalogPath}.${member.name}`] = {
        origin: `${entry.stack!.className}.${member.name}`,
        key: member.location,
        value: member.location,
      };
    }
  }

  try {
    for (const stack of exportStacks) {
      const entry = [...catalog].find(([, item]) => item.stack?.className === stack.className);
      const id = entry ? `resource:${entry[0]}` : `framework-stack:${stack.className}`;
      entities[id] ??= { origin: stack.className, key: stack.location, value: stack.location };
      catalogFacts[id] ??= { stackClass: stack.className, stackLocation: stack.location };
      for (const member of stack.members ?? []) entities[`${id}.${member.name}`] ??= {
        origin: `${stack.className}.${member.name}`, key: member.location, value: member.location,
      };
    }
  } catch (error) { problems.push(`Root environment export stacks could not be read: ${error instanceof Error ? error.message : String(error)}`); }

  let links: Record<string, SourceLocation[]> = {};
  let linkAnalysis: NonNullable<SourceIndex["linkAnalysis"]> = { complete: false, groups: [], unknown: [] };
  try {
    const scanned = readResourceLinks(repositoryRoot, file => files.text(file), located?.properties.stacks);
    links = Object.fromEntries(scanned.sites);
    linkAnalysis = scanned.analysis;
  } catch (error) {
    problems.push(`Application CDK could not be scanned for linkResources: ${error instanceof Error ? error.message : String(error)}`);
  }

  let cdkLinks: CdkLinkIndex = { version: 2, files: {}, edges: [], notes: [], manualWiring: [] };
  try {
    cdkLinks = scanCdkLinks(repositoryRoot, catalog, links);
  } catch (error) {
    problems.push(`CDK resource links could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const taggedEntities = new Set(Object.keys(model.tagging ?? {}));
  for (const [key, entry] of catalog) {
    taggedEntities.add(`resource:${key}`);
    for (const member of entry.stack?.members ?? []) taggedEntities.add(`resource:${key}.${member.name}`);
  }
  const tagSources = located ? { located, catalog } : undefined;
  for (const stack of exportStacks) {
    if ([...catalog.values()].some(item => item.stack?.className === stack.className)) continue;
    const id = `framework-stack:${stack.className}`;
    taggedEntities.add(id);
    const tagLocation = stackTagLocation(repositoryRoot, model, files, stack.className, tagSources);
    if (tagLocation) catalogFacts[id] = { ...catalogFacts[id], tagLocation };
  }
  for (const entity of taggedEntities) editability[entity] = { ...editability[entity], tags: tagEditability(repositoryRoot, model, files, entity, tagSources) };
  let policyRules: SourceIndex["policyRules"] = [];
  if (located) try { policyRules = discoverPolicyRules(repositoryRoot, model, located, file => files.text(file)); }
  catch (error) { problems.push(`IAM policy declarations could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  return {
    index: { entities, editability, links, linkAnalysis, catalog: catalogFacts, problems, cdkLinks, triggerCapabilities, permissionCapabilities, capabilityFiles, policyRules },
    catalog,
    exportStacks,
    ...(located ? { located } : {}),
  };
}
