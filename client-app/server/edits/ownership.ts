import ts from "typescript";
import { OWNER_LABELS, ownershipConsequence, ownershipOf } from "../../shared/framework-management";
import type { ModeModel } from "../../shared/model";
import { assertWritable, toRelative } from "../files";
import { insertExpression } from "../resources-source";
import { SourceFiles } from "../source";
import { findProperty } from "../source/syntax";
import { locateTagSites, type TagSite } from "../source/tags";
import { EditError } from "aws-studio/source/io";
import { replaceValue } from "./splice";
import { tagOwner } from "./tags";

/**
 * Ownership transitions: write an explicit `managedBy` on a declaration.
 *
 * A transition is reviewed on its own (the batch refuses to combine it with other edits) and
 * always records an explicit owner, so the source states the decision. It reuses the tag sites,
 * because every declaration that takes `tags` takes `managedBy` beside them. Entities without a
 * declaration of their own (inherited or undeclared) have nothing to write: their owner changes
 * where it is declared. The ownership guard lets the write through because it ignores
 * `managedBy` when comparing definitions, and refuses it when the definition changes too.
 */

export type ManagedByValue = "framework" | "developer";

/** The declarations one transition writes: a group's entries, or the entity itself. */
export function ownershipTargets(model: ModeModel, entity: string): readonly string[] {
  const own = ownershipOf(model, entity);
  if (own.basis === "inherited") throw new Error(`${entity} follows ${own.from ?? "its owner"}. Change ownership there.`);
  const owner = tagOwner(model, entity);
  const facts = ownershipOf(model, owner);
  if (facts.basis === "inherited") throw new Error(`${owner} follows ${facts.from ?? "its owner"}. Change ownership there.`);
  const resource = model.resources.find(item => item.id === owner);
  if (resource?.kind === "group" && facts.basis === "entries") {
    const entries = model.resources.filter(item => item.parent === owner).map(item => item.id);
    for (const id of entries) {
      const entry = ownershipOf(model, id);
      if (!entry.projectOverride && !["declared", "default", "conflict"].includes(entry.basis)) throw new Error(`${id} has no declaration of its own to record an owner on, so this group's ownership cannot change here.`);
    }
    return entries;
  }
  if ((facts.basis === "catalog" && !facts.projectOverride) || facts.basis === "project" || facts.basis === "undeclared") throw new Error(`${owner} has no declaration that can name an owner. ${facts.note ?? ""}`.trim());
  if (resource?.kind === "member") throw new Error(`${owner} follows its stack. Change ownership on the stack() entry.`);
  return [owner];
}

function rewrite(site: TagSite, value: ManagedByValue, text: string, envName?: string): string {
  if (!site.object) {
    const call = site.call;
    if (!call) throw new Error("This declaration's options could not be located.");
    if (site.argumentIndex === 1 && !call.arguments.length && !envName) throw new Error("This input's environment name cannot be determined. Make it explicit in source first.");
    const at = call.end - 1;
    const separator = call.arguments.length ? call.arguments.hasTrailingComma ? " " : ", " : "";
    return text.slice(0, at) + `${separator}${site.argumentIndex === 1 && !call.arguments.length ? `${JSON.stringify(envName)}, ` : ""}{ managedBy: ${JSON.stringify(value)} }` + text.slice(at);
  }
  // Tag sites address the tags map; ownership sits beside it, in the same options object.
  const segments = [...site.segments.slice(0, -1), "managedBy"];
  if (segments.length !== 1) throw new Error("Ownership belongs to the declaration itself, not one of its members.");
  const found = findProperty(site.object, "managedBy");
  if (found.spread && !found.property) throw new Error("These options come partly from a spread. Set managedBy in source so the spread is reviewed deliberately.");
  if (!found.property) return insertExpression(text, site.source, site.object, segments, JSON.stringify(value));
  if (!ts.isPropertyAssignment(found.property) || !ts.isStringLiteral(found.property.initializer)) throw new Error("managedBy is computed here. Edit it in source.");
  return replaceValue(text, site.source, found.property, value);
}

export function planOwnership(root: string, model: ModeModel, entity: string, value: ManagedByValue, overrides: Map<string, string>): { readonly targets: readonly string[] } {
  try {
    if (value !== "framework" && value !== "developer") throw new Error('An ownership change names "framework" or "developer".');
    const targets = ownershipTargets(model, entity);
    for (const id of targets) {
      const count = locateTagSites(root, model, new SourceFiles(overrides), id).length;
      for (let index = 0; index < count; index++) {
        const files = new SourceFiles(overrides);
        const site = locateTagSites(root, model, files, id)[index]!;
        const file = assertWritable(root, toRelative(root, site.file));
        overrides.set(file, rewrite(site, value, files.text(file), model.resources.find(resource => resource.id === id)?.fromEnv));
      }
    }
    return { targets };
  } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
}

/** Review lines for one transition: what changes, what Studio may then do, and what relies on it. */
export function ownershipSummaries(model: ModeModel, entity: string, value: ManagedByValue, targets: readonly string[]): readonly string[] {
  const owner = tagOwner(model, entity);
  const facts = ownershipOf(model, owner);
  const integrations = [...new Set([owner, ...targets].flatMap(id => ownershipOf(model, id).integrations ?? []))];
  return [
    `${owner} — ownership ${OWNER_LABELS[facts.managedBy].toLowerCase()} → ${OWNER_LABELS[value].toLowerCase()}${targets.length > 1 || targets[0] !== owner ? ` (writes managedBy on ${targets.length} declaration${targets.length === 1 ? "" : "s"})` : ""}. ${ownershipConsequence({ managedBy: value, basis: "declared" })}`,
    ...integrations.map(note => `${owner} — framework integration kept: ${note}`),
  ];
}
