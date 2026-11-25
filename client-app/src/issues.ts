import { isUndeclaredEnvironmentInput, type InputRequirement } from "../shared/deployment-inputs";
import type { DeploymentReadinessIssue, Diagnostic, Mode, ModelResource, ModelTarget } from "../shared/model";
import type { IconKey } from "./icons";
import { entryCount, groupEntries } from "./input-groups";

/**
 * Something wrong with an entity that its owner can fix. An error stops synthesis or a run; a
 * warning leaves something out of it. Every surface reads these producers, so the map badge and
 * caption, the hover card, the Resources row and the inspector notice say the same thing.
 */
export type IssueSeverity = "error" | "warning";

export interface EntityIssue {
  readonly severity: IssueSeverity;
  /** A few words: the notice heading, the badge's meaning and the Resources marker's name. */
  readonly title: string;
  /** What is wrong and how to fix it, one sentence or message each. Names and presence only, never a value. */
  readonly details: readonly string[];
  /** Painted at the map icon's right corner; a connection marks its wire instead. */
  readonly badge: IconKey;
  /** An undeclared variable is one issue even when both input files write it. */
  readonly variable?: string;
}

const ENVIRONMENT: Readonly<Record<Mode, string>> = { dev: "Development", prod: "Production" };

/** Errors first, so the first issue is the one the map paints. */
const ordered = (issues: readonly EntityIssue[]): readonly EntityIssue[] =>
  [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));

/**
 * `resources` is the viewed graph's catalog: a group's issue reads its entries there. Requirements
 * are per graph, so the other environment's missing values recede with it.
 */
export function resourceIssues(resource: ModelResource, resources?: Iterable<ModelResource>): readonly EntityIssue[] {
  if (resource.deploymentFiles && resources) {
    const files = new Set(Object.values(resource.deploymentFiles));
    const members = [...resources].filter((item) => files.has(item.id));
    return ordered([...undeclaredEnvironmentIssues(members), ...members.filter((item) => !item.absent)
      .flatMap((item) => resourceIssues(item).filter((issue) => !issue.variable))]);
  }
  const issues: EntityIssue[] = [];
  const file = resource.deploymentFile;
  // CDK environment shows both files' issues together, so each names its own file.
  const name = file && `.env.${file.mode}`;
  issues.push(...undeclaredEnvironmentIssues([resource]));
  if (file?.setupProblem) {
    issues.push({ severity: "error", title: `${name} could not be created`, badge: "error", details: [file.setupProblem] });
  } else if (file?.problem) {
    issues.push({ severity: "error", title: `${name} could not be read`, badge: "error", details: [file.problem] });
  } else if (file && !file.exists) {
    issues.push({ severity: "error", title: `${name} is missing`, badge: "error",
      details: [`${ENVIRONMENT[file.mode]} synthesis reads ${file.path}. Create it from ${file.template} in CDK environment.`] });
  }
  if (resource.stackUsage?.status === "unreferenced") issues.push(notCreatedIssue(resource));
  issues.push(...deploymentReadinessIssues(resource.readinessIssues));
  const unset = missingValueIssue(resource, resources);
  if (unset) issues.push(unset);
  return ordered(issues);
}

/** Where the application's own stacks are constructed; bin/app.ts loads it. */
export const CDK_APP_FILE = "cdk-app/lib/application.ts";

/**
 * A stack whose class no `new` reaches from the CDK app (application.ts and the files it imports).
 * A catalog stack's fix is the line Studio's own stack creation writes into application.ts.
 */
function notCreatedIssue(resource: ModelResource): EntityIssue {
  const className = resource.stackClass ?? resource.path[resource.path.length - 1]!;
  const declared = resource.frameworkStack ? `${className} exports environment values` : `stacks.${resource.path.join(".")} declares ${className}`;
  return { severity: "warning", title: "Not created in application.ts", badge: "unattached", details: [
    `${declared}, but ${CDK_APP_FILE} never creates it, so it is not synthesized or deployed.`,
    resource.frameworkStack
      ? "Construct it from that file or one it imports."
      : `In that file, add new ${className}(app, stackId("${className}"), { env: stackEnv }) under "Your application stacks go here".`,
  ] };
}

/** Both CDK files must be covered by the input model, regardless of the selected source mode. */
function undeclaredEnvironmentIssues(resources: readonly ModelResource[]): readonly EntityIssue[] {
  const variables = new Map<string, Set<string>>();
  for (const { deploymentFile: file } of resources) {
    if (!file?.exists || file.problem) continue;
    for (const entry of file.entries.filter(isUndeclaredEnvironmentInput))
      variables.set(entry.name, (variables.get(entry.name) ?? new Set()).add(`.env.${file.mode}`));
  }
  return [...variables].sort(([a], [b]) => a.localeCompare(b)).map(([variable, files]) => ({
    severity: "error", title: `${variable} is undeclared`, badge: "error", variable,
    details: [`Used in ${[...files].sort().join(" and ")}. Create an input parameter or secret, or remove this variable in CDK environment.`],
  }));
}

const valueMissing = (entry: ModelResource): boolean => !entry.absent && entry.inputRequirement?.status === "missing";

/**
 * A required input or secret that no value or default supplies, or a group holding any. The file
 * is one remedy, a default the other (secrets take none), so the words name both. Hover cards show
 * them, so they name variables and files only, never values or private reasons.
 */
function missingValueIssue(resource: ModelResource, resources?: Iterable<ModelResource>): EntityIssue | undefined {
  if (resource.kind === "input" || resource.kind === "secret") {
    if (!valueMissing(resource)) return undefined;
    const { name, file, mode } = resource.inputRequirement!;
    const secret = resource.kind === "secret" || resource.inputChoices?.sensitive;
    return { severity: "error", title: "Required value missing", badge: "error", details: [
      `${name} has no value for ${ENVIRONMENT[mode]}: ${file} leaves it unset${secret ? "" : " and no default stands in"}.`,
      secret ? `Set it in ${file}; a secret never takes a source default.`
        : resource.frameworkInput && !resource.inputChoices?.fallback ? `Set it in ${file}; the framework reads it from there and takes no default.`
          : `Set it in ${file}, or give the parameter a default.`,
    ] };
  }
  if (resource.kind !== "group" || !resources) return undefined;
  const unmet = groupEntries(resource, resources).filter(valueMissing);
  if (!unmet.length) return undefined;
  const one = unmet.length === 1;
  const files = [...new Set(unmet.map(entry => entry.inputRequirement!.file))].join(" and ");
  const inputs = unmet.filter(entry => entry.kind === "input" && (!entry.frameworkInput || entry.inputChoices?.fallback)).length;
  const remedy = !inputs ? "" : inputs === unmet.length ? (one ? ", or give it a default" : ", or give them defaults") : ", or give the inputs defaults";
  return { severity: "error", title: one ? "Required value missing" : "Required values missing", badge: "error", details: [
    `${entryCount(unmet)} ${one ? "has" : "have"} no value: ${files} leaves ${one ? "it" : "them"} unset${inputs ? " and no default stands in" : ""}.`,
    `Set ${one ? "it" : "them"} in ${files}${remedy}.`,
  ] };
}

/** Missing source artifacts, and the framework's own validation messages that name this workload. */
export function targetIssues(target: ModelTarget, diagnostics: readonly Diagnostic[] = []): readonly EntityIssue[] {
  const issues: EntityIssue[] = [...deploymentReadinessIssues(target.readinessIssues)];
  const missing = (target.inputRequirements ?? []).filter(requirement => requirement.status === "missing");
  if (missing.length) issues.push({ severity: "error", title: "Required inputs missing", badge: "error", details: missing.map(requirement =>
    `${requirement.name} is required by this workload in ${ENVIRONMENT[requirement.mode]}. Set it in ${requirement.file}${requirement.reasons.length ? ` ${requirement.reasons.join(" ")}` : "."}`) });
  const problems = target.implementation?.ready === false ? target.implementation.problems : [];
  if (target.implementation?.ready === false) {
    issues.push({ severity: "error", title: "Implementation needs attention", badge: "error",
      details: problems.length ? problems : ["Required source artifacts are missing."] });
  }
  for (const severity of ["error", "warning"] as const) {
    const messages = [...new Set(diagnostics
      .filter(diagnostic => diagnostic.entity === target.ref && diagnostic.severity === severity && !problems.includes(diagnostic.message))
      .map(diagnostic => diagnostic.message))];
    if (messages.length) issues.push({ severity, title: severity === "error" ? "Configuration error" : "Configuration warning",
      badge: severity === "error" ? "error" : "warning", details: messages });
  }
  return ordered(issues);
}

export function deploymentReadinessIssues(issues: readonly DeploymentReadinessIssue[] = []): readonly EntityIssue[] {
  return (["error", "warning"] as const).flatMap(severity => {
    const details = [...new Set(issues.filter(issue => issue.severity === severity).map(issue => issue.message))];
    return details.length ? [{ severity, title: severity === "error" ? "Declared access is not ready to deploy" : "Construction not verified", badge: severity === "error" ? "error" as const : "warning" as const, details }] : [];
  });
}

/** A required input that no value or default supplies. Reasons are inspector copy; previews never show them. */
export function requirementIssue(requirement: InputRequirement | undefined): EntityIssue | undefined {
  if (!requirement?.required || requirement.status !== "missing") return undefined;
  return { severity: "error", title: "Required value missing", badge: "error",
    details: [`${requirement.name} is required for ${ENVIRONMENT[requirement.mode]}. No non-blank environment value or declaration default supplies it.`, ...requirement.reasons] };
}
