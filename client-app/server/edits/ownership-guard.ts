import path from "node:path";
import ts from "typescript";
import { locateConfigSource, type LocatedConfigSource } from "aws-studio/source-index";
import type { ModeModel, Owner } from "../../shared/model";
import { toRelative } from "../files";
import { FRAMEWORK_SETTING_FILES, frameworkInputChoices, locateFrameworkSetting } from "../input-choices-source";
import { parseOrigin } from "../model/origin";
import { readConfiguredCatalog, type CatalogEntrySource } from "../source/catalog";
import { matchesExportStack } from "../source/export-stacks";
import { locateManagedDatabase } from "../source/database";
import { literalKey } from "../source/syntax";
import { SourceFiles } from "../source";
import type { StudioState } from "../snapshot";
import { EditError } from "aws-studio/source/io";

/**
 * Server-side enforcement of ownership, for every writer: Studio's structured editors,
 * its other source writers (through `io.ts`) and Coding-task proposals.
 *
 * Checked against the exact proposed file contents:
 *  - The stack class file of a platform-maintained or unresolved stack is not written.
 *  - A platform-maintained or unresolved declaration keeps its exact tokens, ignoring only its
 *    `tags` and `managedBy` properties, comments and formatting.
 *  - A change to an entity's `managedBy` is an ownership transition. It is reported, and it
 *    is refused when the same change also alters that entity's definition: ownership changes
 *    are reviewed on their own.
 * Developer-owned definitions are not restricted. Values supplied through input files and
 * other configuration writers never contain declarations, so they pass untouched.
 */

export interface ProposedChange {
  /** Absolute path. */
  readonly file: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface OwnershipTransition {
  readonly entity: string;
  readonly from: Owner;
  readonly to: Owner;
  /** Repository-relative file whose declaration changes. */
  readonly file: string;
}

interface Span { readonly start: number; readonly end: number }
interface Declaration { readonly file: string; readonly spans: readonly Span[]; readonly configuration?: readonly Span[] }

const IGNORED_PROPERTIES = new Set(["tags", "managedBy"]);
const MODELS = (state: StudioState) => [state.snapshot.models.dev, state.snapshot.models.prod];

/** The strictest owner across both graphs: platform first, then unresolved, then developer. */
export function guardedOwner(state: StudioState, id: string): Owner {
  // Only graphs that hold the entity give evidence; an entity neither holds is unresolved.
  const owners = MODELS(state).flatMap(model => model.ownership?.[id]?.managedBy ?? []);
  if (!owners.length) return "unresolved";
  return owners.includes("framework") ? "framework" : owners.includes("unresolved") ? "unresolved" : "developer";
}

/** Entities that have declarations of their own, which a write could change. */
function declaredEntities(state: StudioState): Map<string, ModeModel> {
  const result = new Map<string, ModeModel>();
  for (const model of MODELS(state)) for (const [id, facts] of Object.entries(model.ownership ?? {})) {
    if ((facts.projectOverride || facts.basis === "declared" || facts.basis === "default" || facts.basis === "conflict") && !result.has(id)) result.set(id, model);
  }
  return result;
}

/** Stack class files whose stack is not developer owned, keyed by repository-relative file. */
export function protectedStackFiles(state: StudioState): Map<string, string> {
  const files = new Map<string, string>();
  const catalogClasses: CatalogEntrySource["stack"][] = [];
  for (const [key, entry] of state.built.catalog ?? []) {
    if (!entry.stack?.location) continue;
    catalogClasses.push(entry.stack);
    if (guardedOwner(state, `resource:${key}`) !== "developer") files.set(entry.stack.location.file, `resource:${key}`);
  }
  // Export stacks also have a Studio ownership record when the app has no stack() entry.
  for (const stack of state.built.exportStacks ?? []) {
    const id = `framework-stack:${stack.className}`;
    if (!catalogClasses.some(entry => matchesExportStack(entry, stack)) && guardedOwner(state, id) !== "developer") files.set(stack.location.file, id);
  }
  return files;
}

function stackRefusal(relativeFile: string, id: string, owner: Owner): string {
  return owner === "framework"
    ? `${relativeFile} defines ${id}, which the AWS Studio platform maintains. Studio protects this stack's implementation.`
    : `Studio could not verify the owner of ${id} in ${relativeFile}. Refresh the project before editing its stack source.`;
}

/** Refuse a native CDK write into a stack class that is not developer owned. */
export function assertStackSourceWritable(state: StudioState, relativeFile: string): void {
  const normalized = relativeFile.replaceAll("\\", "/");
  const id = protectedStackFiles(state).get(normalized);
  if (id) throw new EditError(422, stackRefusal(normalized, id, guardedOwner(state, id)));
}

/** Where an entity's declaration is written: key and value spans. */
function locateDeclaration(root: string, model: ModeModel, located: LocatedConfigSource, catalog: ReadonlyMap<string, CatalogEntrySource>, files: SourceFiles, id: string): Declaration[] | undefined {
  const target = model.targets.find(target => target.ref === id);
  const gateway = model.gateways?.find(gateway => gateway.id === id && gateway.protocol === "agentcore");
  const origins = target?.origins ?? (gateway?.protocol === "agentcore" ? [gateway.origin] : undefined);
  if (origins) {
    const found: Declaration[] = [];
    for (const origin of origins) {
      const parsed = parseOrigin(origin);
      const entry = parsed && parsed.section !== "defaults" ? located.sections[parsed.section].find(entry => entry.key === parsed.key) : undefined;
      if (!entry) return undefined;
      found.push({ file: entry.file, spans: [entry.keySpan, entry.valueSpan] });
    }
    return found;
  }
  if (id.startsWith("island:vpc:")) {
    const entry = located.networks.find(network => `island:vpc:${network.id}` === id);
    return entry ? [{ file: entry.file, spans: [entry.span] }] : undefined;
  }
  if (id.startsWith("database:")) {
    const database = locateManagedDatabase(root, files);
    if (!database || id !== `database:${database.id}`) return undefined;
    const configuration = database.object.properties.filter(property => ts.isPropertyAssignment(property) && ["settings", "vpc", "subnet"].includes(literalKey(property) ?? ""))
      .map(property => ({ start: property.getStart(database.source), end: property.end }));
    return [{ file: database.file, spans: [database.span], configuration }];
  }
  if (id.startsWith("resource:")) {
    const entry = catalog.get(id.slice("resource:".length));
    if (!entry) return undefined;
    return entry.key.file === entry.value.file
      ? [{ file: path.join(root, entry.key.file), spans: [entry.key, entry.value] }]
      : [{ file: path.join(root, entry.key.file), spans: [entry.key] }, { file: path.join(root, entry.value.file), spans: [entry.value] }];
  }
  const setting = /^framework:(deployment|local)\.(.+)$/.exec(id);
  if (setting) {
    const file = path.join(root, FRAMEWORK_SETTING_FILES[setting[1] as keyof typeof FRAMEWORK_SETTING_FILES]);
    let span: Span | undefined;
    try { span = locateFrameworkSetting(files.get(file), setting[2]!); } catch { return undefined; }
    if (!span) return undefined;
    const resource = model.resources.find(item => item.id === id);
    const policy = resource?.inputChoices;
    if (!policy || !resource.fromEnv || model.ownership?.[id]?.basis !== "catalog") return [{ file, spans: [span] }];
    const builder = frameworkInputChoices(root, setting[1]!, setting[2]!, resource.fromEnv, new Map([[file, files.text(file)]]));
    const configuration = builder?.calls.filter(call => {
      if (call.name === "enum") return !policy.sensitive;
      if (call.name === "default") return policy.fallback;
      return policy.policy && builder.literalPolicy && (call.name === "required" || call.name === "only" && policy.availability);
    }).map(call => ({ start: call.receiver.end, end: call.node.end }));
    return [{ file, spans: [span], configuration }];
  }
  return undefined;
}

/** Tokens of a declaration, without trivia, commas, empty objects, or its metadata properties. */
export function declarationSignature(source: ts.SourceFile, start: number, end: number, configuration: readonly Span[] = []): string {
  const skipped = [...configuration];
  const visit = (node: ts.Node): void => {
    if (node.pos >= end || node.end <= start) return;
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.getStart(source) >= start && node.end <= end) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      if (name && IGNORED_PROPERTIES.has(name)) { skipped.push({ start: node.getStart(source), end: node.end }); return; }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source.text.slice(start, end));
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const at = start + scanner.getTokenStart();
    if (kind === ts.SyntaxKind.CommaToken || skipped.some(range => at >= range.start && at < range.end)) continue;
    const text = scanner.getTokenText();
    // Removing the last metadata property may leave, or remove, an empty options object.
    if (text === "}" && tokens.at(-1) === "{") { tokens.pop(); continue; }
    tokens.push(text);
  }
  return tokens.join("\u0000");
}

/** The explicit owner in this span. Omission uses the Studio catalog or project default. */
export function declaredOwner(source: ts.SourceFile, start: number, end: number): Owner | undefined {
  let found: Owner | undefined;
  const visit = (node: ts.Node): void => {
    if (found || node.pos >= end || node.end <= start) return;
    if (ts.isPropertyAssignment(node) && node.getStart(source) >= start && node.end <= end && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "managedBy") {
      // A computed owner is not evidence Studio can read.
      found = ts.isStringLiteral(node.initializer) && (node.initializer.text === "framework" || node.initializer.text === "developer") ? node.initializer.text : "unresolved";
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

interface Located { readonly signature: string; readonly owner: Owner; readonly explicit: boolean }

function read(declarations: readonly Declaration[], files: SourceFiles, defaultOwner: Owner, omitConfiguration = false): Located {
  const owners = new Set<Owner>();
  const signature = JSON.stringify(declarations.map(declaration => declaration.spans.map(span => {
    const source = files.get(declaration.file);
    const explicit = declaredOwner(source, span.start, span.end);
    if (explicit) owners.add(explicit);
    return declarationSignature(source, span.start, span.end, omitConfiguration ? declaration.configuration : undefined);
  })));
  return { signature, owner: owners.size > 1 ? "unresolved" : [...owners][0] ?? defaultOwner, explicit: owners.size > 0 };
}

/** Snapshot-time facts for a quick decision: which files hold which declarations. */
const indexes = new WeakMap<StudioState, { readonly byFile: ReadonlyMap<string, readonly string[]>; readonly stackFiles: ReadonlyMap<string, string> }>();
function indexOf(root: string, state: StudioState) {
  const cached = indexes.get(state);
  if (cached) return cached;
  const byFile = new Map<string, string[]>();
  try {
    const files = new SourceFiles();
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    const catalog = readConfiguredCatalog(root, located, file => files.text(file));
    for (const [id, model] of declaredEntities(state)) for (const declaration of locateDeclaration(root, model, located, catalog, files, id) ?? []) {
      const file = path.resolve(declaration.file);
      byFile.set(file, [...(byFile.get(file) ?? []), id]);
    }
  } catch { /* Unreadable source: per-change checks below locate what they can. */ }
  const index = { byFile, stackFiles: protectedStackFiles(state) };
  indexes.set(state, index);
  return index;
}

/** Whether a file holds a declaration or stack source whose ownership a write must check. */
export function ownershipRelevantFile(root: string, state: StudioState, file: string): boolean {
  const index = indexOf(root, state);
  return index.byFile.has(path.resolve(file)) || index.stackFiles.has(toRelative(root, path.resolve(file)));
}

const ownerName = (owner: Owner) => owner === "framework" ? "the AWS Studio platform maintains it" : "Studio could not verify its owner";

/**
 * Assess a proposed change set against ownership. Throws an EditError naming the first
 * entity it may not change; otherwise returns the ownership transitions it makes.
 */
export function assessOwnership(root: string, state: StudioState, changes: readonly ProposedChange[]): readonly OwnershipTransition[] {
  const changed = new Map(changes.filter(change => change.before !== change.after).map(change => [path.resolve(change.file), change]));
  if (!changed.size) return [];
  const index = indexOf(root, state);
  for (const file of changed.keys()) {
    const relative = toRelative(root, file);
    const id = index.stackFiles.get(relative);
    if (id) throw new EditError(422, stackRefusal(relative, id, guardedOwner(state, id)));
  }
  const affected = new Set([...changed.keys()].flatMap(file => index.byFile.get(file) ?? []));
  // Files that hold no declaration today can still gain one; only existing declarations are guarded.
  if (!affected.size) return [];
  const entities = declaredEntities(state);
  const overlay = (side: "before" | "after") => new SourceFiles(new Map([...changed].flatMap(([file, change]) => change[side] === null ? [] : [[file, change[side]!] as const])));
  const beforeFiles = overlay("before"), afterFiles = overlay("after");
  const locate = (files: SourceFiles) => {
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: files.host() });
    return { located, catalog: readConfiguredCatalog(root, located, file => files.text(file)) };
  };
  const guarded = [...affected].filter(id => guardedOwner(state, id) !== "developer");
  const unverifiable = (reason: string) => {
    const id = guarded[0];
    if (id) throw new EditError(422, `${id}: ${ownerName(guardedOwner(state, id))}, and ${reason}, so Studio cannot verify that its definition is unchanged.`);
  };
  let before: ReturnType<typeof locate>, after: ReturnType<typeof locate>;
  try { before = locate(beforeFiles); } catch (error) { unverifiable(`the current source does not evaluate (${error instanceof Error ? error.message : String(error)})`); return []; }
  try { after = locate(afterFiles); } catch (error) { unverifiable(`the proposed source no longer declares it in a form Studio can read (${error instanceof Error ? error.message : String(error)})`); return []; }

  const transitions: OwnershipTransition[] = [];
  for (const id of affected) {
    const model = entities.get(id);
    if (!model) continue;
    const owner = guardedOwner(state, id);
    const declared = locateDeclaration(root, model, before.located, before.catalog, beforeFiles, id);
    // A declaration the locator cannot read is computed in source; there is no span to compare.
    if (!declared?.some(declaration => changed.has(path.resolve(declaration.file)))) continue;
    const file = toRelative(root, declared.find(declaration => changed.has(path.resolve(declaration.file)))!.file);
    const deleted = declared.some(declaration => changed.get(path.resolve(declaration.file))?.after === null);
    const next = deleted ? undefined : locateDeclaration(root, model, after.located, after.catalog, afterFiles, id);
    if (!next || next.length !== declared.length) {
      if (owner !== "developer") throw new EditError(422, `${id}: ${ownerName(owner)}. This change removes or renames its declaration in ${file}; Studio does not change a definition it does not own.`);
      continue;
    }
    const defaultOwner = model.ownership?.[id]?.projectOverride ? "framework" : "developer";
    const was = read(declared, beforeFiles, defaultOwner), now = read(next, afterFiles, defaultOwner);
    const redefined = was.signature !== now.signature;
    const overrideChanged = defaultOwner === "framework" && was.explicit !== now.explicit;
    if (was.owner !== now.owner || overrideChanged) {
      if (redefined) throw new EditError(422, `${id}: this change alters both its ownership (${was.owner} → ${now.owner}) and its definition in ${file}. Change ownership in its own review, then edit it.`);
      transitions.push({ entity: id, from: was.owner, to: now.owner, file });
      continue;
    }
    if (redefined && owner !== "developer") {
      // Compare the implementation after removing both versions' supported project settings.
      if (model.ownership?.[id]?.basis === "catalog" && declared.some(site => site.configuration) &&
          read(declared, beforeFiles, defaultOwner, true).signature === read(next, afterFiles, defaultOwner, true).signature) continue;
      throw new EditError(422, `${id}: ${ownerName(owner)}, so Studio does not change its definition in ${file}. Its tags and supplied values stay editable.`);
    }
  }
  return transitions;
}

/** Throwing form for writers that only need the refusal. */
export function assertOwnershipAllows(root: string, state: StudioState, changes: readonly ProposedChange[]): void {
  assessOwnership(root, state, changes);
}
