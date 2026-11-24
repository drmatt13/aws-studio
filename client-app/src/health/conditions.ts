import type { Diagnostic, DiagnosticLocation, Mode, ModeModel } from "../../shared/model";
import type { SourceWatchState } from "../../shared/watch";

export type HealthSeverity = "error" | "warning" | "notice";
export type HealthAction = "reload-source" | "retry-refresh";
/** What a condition does to one capability. Each maps to a line the server or client enforces. */
export type HealthCapabilityState = "paused" | "last-loaded" | "caution" | "working";

export interface HealthCapability {
  readonly state: HealthCapabilityState;
  readonly name: string;
  readonly note?: string;
}

export interface HealthFinding {
  readonly key: string;
  readonly summary: string;
  readonly detail?: string;
  /** The modes reporting it. Empty when it belongs to the source rather than a mode. */
  readonly modes: readonly Mode[];
  /** Where it arose, when that adds to the title: a load failure's title already says so. */
  readonly stage?: Exclude<Diagnostic["stage"], "load"> | "source-index";
  readonly location?: DiagnosticLocation;
  readonly entity?: string;
}

export interface HealthCondition {
  readonly id: "connection" | "configuration" | "source-watch" | "notes";
  readonly severity: HealthSeverity;
  readonly title: string;
  readonly explanation: string;
  /** The compact form for the indicator: a file and line when one is known. */
  readonly label: string;
  /** What this means right now, for the indicator's accessible name. */
  readonly impact?: string;
  readonly labelIsPlace?: boolean;
  /** The workspace is displaying data that may no longer match saved source. */
  readonly showsLastLoaded: boolean;
  readonly findings: readonly HealthFinding[];
  readonly capabilities: readonly HealthCapability[];
  readonly action?: HealthAction;
  readonly askAgent: boolean;
  /** Toast text for the transition into this condition. Absent means it stays quiet. */
  readonly raised?: string;
  /** Toast text for the transition out of it. */
  readonly recovered?: string;
}

export interface HealthInputs {
  readonly models: Readonly<Record<Mode, ModeModel>>;
  readonly sourceProblems: readonly string[];
  readonly sourceWatch: SourceWatchState | undefined;
  readonly repositoryRoot: string;
  /** Why the latest snapshot request failed, while the previous snapshot remains on screen. */
  readonly refreshFailure?: string;
  /** When this tab last saw every mode load. */
  readonly lastLoadedAt?: string;
}

export interface HealthIndicator {
  readonly severity: HealthSeverity | "healthy";
  readonly label?: string;
  readonly labelIsPlace: boolean;
  readonly additional: number;
  readonly showsLastLoaded: boolean;
  readonly description: string;
}

const EDITING: HealthCapability = { state: "paused", name: "Inspector edits and Add to application" };
const VIEWS = "Map, inspectors and routes";
const SAVED_SOURCE: HealthCapability = { state: "caution", name: "Synthesize and Deploy", note: "read saved source, so they can stop on this error" };
const INDEPENDENT: HealthCapability = { state: "working", name: "Activity, Agent, Database, Docker and the local runtime" };

const TRANSFORM_WRAPPER = /^Transform failed with \d+ errors?:\n/;
const TRANSFORM_POSITION = /^.+?:\d+:\d+: ERROR: /;

/** The error as written, without transformer wrapping or machine-specific paths. */
function readable(message: string, repositoryRoot: string): { readonly summary: string; readonly detail?: string } {
  const lines = message.replaceAll(`${repositoryRoot}/`, "").replace(TRANSFORM_WRAPPER, "").split("\n").map((line) => line.replace(TRANSFORM_POSITION, ""));
  const [summary = "", ...rest] = lines;
  return { summary, ...(rest.length ? { detail: rest.join("\n") } : {}) };
}

/** Both modes usually report one failure, so identical diagnostics become one finding. */
function findings(models: HealthInputs["models"], severity: Diagnostic["severity"], repositoryRoot: string): readonly HealthFinding[] {
  const merged = new Map<string, HealthFinding>();
  for (const mode of Object.keys(models) as Mode[]) {
    for (const diagnostic of models[mode].diagnostics) {
      if (diagnostic.severity !== severity) continue;
      const key = `${diagnostic.stage}\u0000${diagnostic.message}`;
      const known = merged.get(key);
      merged.set(key, known ? { ...known, modes: [...known.modes, mode] } : {
        key, modes: [mode], ...(diagnostic.stage === "load" ? {} : { stage: diagnostic.stage }), ...readable(diagnostic.message, repositoryRoot),
        ...(diagnostic.location ? { location: diagnostic.location } : {}),
        ...(diagnostic.entity ? { entity: diagnostic.entity } : {}),
      });
    }
  }
  return [...merged.values()];
}

const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const place = (location: DiagnosticLocation) => `${location.file.split("/").at(-1)}:${location.line}`;

function configurationCondition({ models, repositoryRoot, sourceWatch, lastLoadedAt }: HealthInputs): HealthCondition | undefined {
  const every = Object.values(models);
  const stale = every.some((model) => model.stale);
  const neverLoaded = !stale && every.some((model) => model.status === "error" && model.targets.length === 0);
  if (!stale && !every.some((model) => model.status === "error")) return undefined;
  const errors = findings(models, "error", repositoryRoot);
  const location = errors.find((item) => item.location)?.location;
  const reload = sourceWatch?.status === "unavailable" ? "Save a fix, then reload source." : "Studio reloads as soon as a fix is saved.";
  const shared = { id: "configuration", severity: "error", showsLastLoaded: stale, findings: errors, action: "reload-source", askAgent: true } as const;
  if (stale || neverLoaded) {
    const named = location ? place(location) : undefined;
    return {
      ...shared,
      title: "Configuration doesn’t load",
      explanation: stale
        ? `Studio is showing the version that last loaded${lastLoadedAt ? ` at ${clock(lastLoadedAt)}` : ""}. It may not match saved source. ${reload}`
        : `Studio has no earlier version to show. ${reload}`,
      label: named ?? "Configuration error",
      labelIsPlace: !!named,
      impact: stale ? "Showing the last version that loaded. Editing is paused." : "Nothing has loaded yet. Editing is paused.",
      capabilities: [EDITING, stale ? { state: "last-loaded", name: VIEWS } : { state: "paused", name: VIEWS }, SAVED_SOURCE, INDEPENDENT],
      raised: `Configuration doesn’t load${named ? `: ${named}` : ""}. Editing is paused.`,
      recovered: "Configuration loads again. Editing is back.",
    };
  }
  return {
    ...shared,
    title: "Configuration has errors",
    explanation: `The map is current, but Studio can’t check edits against it until these are fixed. ${reload}`,
    label: "Configuration errors",
    impact: "The map is current. Editing is paused.",
    capabilities: [EDITING, SAVED_SOURCE, INDEPENDENT],
    raised: "Configuration has errors. Editing is paused.",
    recovered: "Configuration errors are fixed. Editing is back.",
  };
}

function connectionCondition({ refreshFailure }: HealthInputs): HealthCondition | undefined {
  if (refreshFailure === undefined) return undefined;
  return {
    id: "connection", severity: "error",
    title: "Studio couldn’t refresh the configuration",
    explanation: "Your current map and draft are preserved.",
    label: "Refresh failed",
    impact: "Your current map and draft are preserved.",
    showsLastLoaded: true,
    findings: [{ key: "refresh", summary: refreshFailure, modes: [] }],
    capabilities: [
      { state: "last-loaded", name: VIEWS },
      { state: "caution", name: "Anything that needs the Studio server", note: "can fail until it responds" },
      { state: "working", name: "Your unsaved draft" },
    ],
    action: "retry-refresh",
    // The agent runs on the same server, so it cannot help with this one.
    askAgent: false,
    raised: "Studio couldn’t refresh the configuration.",
    recovered: "Configuration refreshed.",
  };
}

function watchCondition({ sourceWatch }: HealthInputs): HealthCondition | undefined {
  if (!sourceWatch || sourceWatch.status === "watching") return undefined;
  const polling = sourceWatch.status === "polling";
  const seconds = sourceWatch.pollIntervalMs / 1000;
  const title = polling ? "Source watching is interrupted" : "Source freshness is unknown";
  const explanation = polling ? `Checking for changes every ${seconds}s.` : "Some files could not be read, so the map may not match saved source.";
  return {
    id: "source-watch", severity: "warning", title, explanation,
    label: polling ? "Polling for changes" : "Freshness unknown",
    impact: explanation,
    showsLastLoaded: false,
    findings: sourceWatch.problems.map((problem, at) => ({ key: `${at}`, summary: `${problem.path}: ${problem.code}`, modes: [] })),
    capabilities: [
      { state: "caution", name: "Map and inspectors", note: polling ? `can take up to ${seconds}s to show saved changes` : "may not match saved source" },
      { state: "working", name: "Editing, Deploy, Database, Activity and Agent" },
    ],
    action: "reload-source", askAgent: true,
    raised: `${title}. ${explanation}`,
    recovered: "Source watching is back.",
  };
}

function notesCondition({ models, repositoryRoot, sourceProblems }: HealthInputs): HealthCondition | undefined {
  const notes: readonly HealthFinding[] = [
    ...findings(models, "warning", repositoryRoot),
    ...sourceProblems.map((problem) => ({ key: problem, summary: problem, modes: [], stage: "source-index" as const })),
  ];
  if (!notes.length) return undefined;
  return {
    id: "notes", severity: "notice", title: "Notes", explanation: "These don’t stop anything, but they may need a look.",
    label: `${notes.length} ${notes.length === 1 ? "note" : "notes"}`,
    showsLastLoaded: false, findings: notes, capabilities: [], askAgent: false,
  };
}

/** Every unresolved condition, most severe first. The single source for the indicator, panel and toasts. */
export function healthConditions(inputs: HealthInputs): readonly HealthCondition[] {
  return [connectionCondition, configurationCondition, watchCondition, notesCondition].flatMap((build) => build(inputs) ?? []);
}

export function healthIndicator(conditions: readonly HealthCondition[]): HealthIndicator {
  const [lead, ...others] = conditions;
  if (!lead) return { severity: "healthy", labelIsPlace: false, additional: 0, showsLastLoaded: false, description: "Configuration health: all clear" };
  const located = lead.labelIsPlace ? lead.findings.find((item) => item.location)?.location : undefined;
  const where = located ? `, ${located.file.split("/").at(-1)} line ${located.line}` : "";
  const more = others.length ? ` ${others.length} more ${others.length === 1 ? "condition" : "conditions"}.` : "";
  return {
    severity: lead.severity, label: lead.label, labelIsPlace: !!lead.labelIsPlace, additional: others.length, showsLastLoaded: lead.showsLastLoaded,
    description: `Configuration health: ${lead.title}${where}.${lead.impact ? ` ${lead.impact}` : ""}${more}`,
  };
}

/** An editable message for the Agent composer. Nothing sends it. */
export function healthAgentPrompt(condition: HealthCondition): string {
  const scope = (finding: HealthFinding) => finding.modes.length === 1 ? [`Affects: ${finding.modes[0] === "dev" ? "Development" : "Production"} only`] : [];
  return [
    "Help me fix this Studio configuration problem.",
    "",
    `Problem: ${condition.title}`,
    ...condition.findings.flatMap((finding) => [
      "",
      ...(finding.location ? [`File: ${finding.location.file}:${finding.location.line}:${finding.location.column}`] : []),
      ...scope(finding),
      "```text", finding.summary, ...(finding.detail ? [finding.detail] : []), "```",
    ]),
    "",
    "What is wrong, and what is the smallest fix?",
  ].join("\n");
}
