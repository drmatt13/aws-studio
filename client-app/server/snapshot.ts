import type { Mode, ModeModel, ModelResource, Snapshot } from "../shared/model";
import { applicationSummary } from "./app-name";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EvaluatorLifetime, EvaluatorPool, type Evaluation } from "./evaluator/pool";
import { hashEditableFiles, sha256 } from "./files";
import { buildSourceIndex, SourceFiles, type BuiltSourceIndex } from "./source";
import type { CatalogEntrySource } from "./source/catalog";
import { readDeclaredSchema, readLocalDatabases, withLocalDatabases } from "./database";
import { frameworkSettingOwnership, withDeploymentInputs } from "./deployment-inputs";
import { EMPTY_INPUT_METADATA } from "./evaluator/input-metadata";
import { withExportStacks } from "./source/export-stacks";
import { readDescriptions } from "./descriptions";
import { namingCapabilities, readDisplayNames } from "./naming-metadata";
import { disposeNamingWorkers } from "./naming-service";
import { withConnectionEvidence } from "./source/evidence";
import { withConnectionAuthorizations } from "../shared/permissions";
import { withPermissionReadiness } from "../shared/permission-readiness";
import { withClientEnvironment } from "./client-environment";
import { readClientMappings } from "./client-environment-source";
import { clientBindingFor } from "../shared/client-environment";
import { STACK_MEMBER_TAGGING, tagFacts, withAbsentTagging } from "./model/tags";
import { mergeDeclaredOwnership, withOwnership } from "./model/ownership";
import { failedModel } from "./model/project";
import { replaceFileAtomic } from "aws-studio/cli/atomic-replace.cjs";
import { SOURCE_HOLD_NOTE, sourceHeld } from "../shared/api";
import { ownsSourceGate, publishSourceSnapshot, releaseAbandonedSourceRead, SourceGateObserver, sourceOwnedEntryEpoch, sourcePublicationEpoch, SourceGateError, type SourceCoordinationState } from "aws-studio/source/source-gate";

/**
 * The studio's current understanding of the repository, rebuilt as a whole.
 *
 * A snapshot is never patched: a change anywhere evaluates both modes again,
 * re-reads the source and replaces it. Refreshes are serialized, and one that
 * is asked for while another runs is coalesced into a single follow-up.
 */

/** A stack's members as its class declares them, merged with the ones workloads read. */
function withClassMembers(model: ModeModel, catalog: ReadonlyMap<string, CatalogEntrySource>, cdkEdges: ModeModel["edges"]): ModeModel {
  const tagging = { ...model.tagging };
  const resources: ModelResource[] = [...model.resources];
  const index = new Map(resources.map((resource, position) => [resource.id, position]));
  for (const [catalogPath, entry] of catalog) {
    if (!entry.stack) continue;
    const stack = resources[index.get(`resource:${catalogPath}`) ?? -1];
    for (const member of entry.stack.members) {
      const id = `resource:${catalogPath}.${member.name}`;
      const parent = `resource:${catalogPath}`;
      const capability = member.category === "value" ? { kind: "logical" as const, note: "Public stack values have no independently taggable AWS resource." } : STACK_MEMBER_TAGGING;
      tagging[id] = { ...(tagging[id] ?? tagFacts(id, {}, capability, { entity: parent, tags: tagging[parent]?.effective ?? {} })), aws: capability };
      const existing = index.get(id);
      if (existing !== undefined) {
        const resource = resources[existing]!;
        const managed = resource.frameworkManaged === "database";
        resources[existing] = { ...resource, nativeKind: member.category === "construct" ? "resource" : member.category, typeText: member.typeText, memberSource: "both",
          networkPlacement: managed ? model.managedDatabase?.subnet ?? member.networkPlacement : member.networkPlacement,
          networkId: managed ? model.databaseNetworkId : member.networkId };
        continue;
      }
      index.set(id, resources.length);
      resources.push({
        id,
        path: [...catalogPath.split("."), member.name],
        kind: "member",
        parent: `resource:${catalogPath}`,
        absent: stack?.absent === true,
        typeText: member.typeText,
        memberSource: "class",
        nativeKind: member.category === "construct" ? "resource" : member.category,
        networkPlacement: member.networkPlacement, networkId: member.networkId,
      });
    }
    if (stack) resources[index.get(`resource:${catalogPath}`)!] = { ...stack, stackClass: entry.stack.className, stackUsage: entry.stackUsage };
  }
  const ids = new Set([...resources.map((resource) => resource.id), ...model.targets.map((target) => target.ref)]);
  const ownership = resources.filter((resource) => resource.frameworkManaged && resource.networkPlacement && resource.parent && ids.has(resource.parent)).map((resource): ModeModel["edges"][number] => ({
    id: `contains:${resource.parent}->${resource.id}`,
    relation: "contains",
    from: resource.parent!,
    to: resource.id,
    provenance: "derived",
    label: "Database in stack",
    detail: "This stack declares the application's framework-managed database.",
  }));
  return { ...model, resources, tagging,
    networks: model.networks?.map(network => ({ ...network, builtInProd: network.builtInProd || [...catalog].some(([name, entry]) => entry.stack?.networkIds?.includes(network.id) && entry.stackUsage?.status === "referenced" && resources.some(resource => resource.id === `resource:${name}` && !resource.absent)) })),
    edges: [...model.edges, ...ownership, ...cdkEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))] };
}

export interface StudioState {
  readonly snapshot: Snapshot;
  readonly evaluation: Evaluation;
  readonly built: BuiltSourceIndex;
}

/** Everything a viewer can see of a snapshot, leaving out when and how quickly it was produced. */
function visibleContent({ revision: _revision, generatedAt: _generatedAt, ...content }: Snapshot): string {
  return JSON.stringify(content, (key, value: unknown) => key === "evaluatedInMs" ? undefined : value);
}

export class SnapshotBuilder {
  private closed = false;
  readonly evaluators = new EvaluatorLifetime();
  private generation = 0;
  private running: Promise<StudioState> | undefined;
  private pending: Promise<StudioState> | undefined;
  private latest: StudioState | undefined;
  private latestEpoch: string | undefined;
  readonly pool: EvaluatorPool;
  private readonly sourceObserver: SourceGateObserver;

  constructor(
    readonly repositoryRoot: string,
    log: (line: string) => void = () => {},
    private readonly inputSetupProblems: () => Readonly<Partial<Record<Mode, string>>> = () => ({}),
    readonly conditionInputRoot = repositoryRoot,
  ) {
    this.pool = new EvaluatorPool(repositoryRoot, log, this.evaluators, undefined, conditionInputRoot);
    this.sourceObserver = new SourceGateObserver(repositoryRoot);
  }

  get current(): StudioState | undefined {
    return this.currentFor(this.publicationState);
  }

  private currentFor(publication: SnapshotBuilder["publicationState"]): StudioState | undefined {
    const current = this.latest;
    if (!current || publication.status === "ready") return current;
    const error = new Error(publication.message ?? "Source publication is paused. The last complete architecture is retained until a fresh evaluation succeeds.");
    const dev = failedModel("dev", error, 0), prod = failedModel("prod", error, 0);
    return { ...current, evaluation: { dev, prod, preflight: async () => ({ dev: { mode: "dev", ok: false, diagnostics: dev.diagnostics }, prod: { mode: "prod", ok: false, diagnostics: prod.diagnostics } }) },
      snapshot: { ...current.snapshot, models: { dev: { ...current.snapshot.models.dev, status: "error", stale: true, diagnostics: dev.diagnostics }, prod: { ...current.snapshot.models.prod, status: "error", stale: true, diagnostics: prod.diagnostics } } } };
  }

  /**
   * What the browser shows. A running operation holds the source, and the
   * refresh after it publishes: both are ordinary work, so the last complete
   * graph stays exactly as it was. `current` keeps refusing edits against it.
   */
  get presented(): StudioState | undefined {
    return this.presentation.state;
  }

  /** Read one coordination record for a response, rather than reopening it for each field. */
  get presentation(): { readonly state: StudioState | undefined; readonly publication: SnapshotBuilder["publicationState"] } {
    const publication = this.publicationState;
    return { state: sourceHeld(publication.status) ? this.latest : this.currentFor(publication), publication };
  }

  /** Why edits wait when nothing is wrong, in place of blaming the configuration. */
  get sourceHold(): string | undefined {
    return sourceHeld(this.publicationState.status) ? SOURCE_HOLD_NOTE : undefined;
  }

  get publicationState(): SourceCoordinationState | { readonly status: "refresh_required"; readonly epoch: string; readonly message: string } {
    const state = this.sourceObserver.state();
    // An owning editor may use its prior evaluation to finish its bounded edit.
    // Other request contexts cannot treat that graph as current while it writes.
    if (ownsSourceGate(this.repositoryRoot) && (this.latestEpoch === state.epoch || this.latestEpoch === sourceOwnedEntryEpoch(this.repositoryRoot))) return { status: "ready", epoch: state.epoch };
    if (state.status !== "ready") return state;
    if (this.latestEpoch !== state.epoch) return { status: "refresh_required", epoch: state.epoch, message: "Saved source changed. Refresh Studio to publish a complete architecture before editing it." };
    return { status: "ready", epoch: state.epoch };
  }

  /**
   * Rebuilds. While a rebuild runs, every request joins one follow-up that
   * starts when it finishes, so the last change is always seen and no more than
   * one extra evaluation is ever queued.
   */
  refresh(): Promise<StudioState> {
    if (this.closed) return Promise.reject(new Error("The snapshot builder is closed."));
    if (this.pending) return this.pending;
    if (this.running) {
      this.pending = this.running
        .catch(() => undefined)
        .then(() => {
          this.pending = undefined;
          return this.start();
        });
      return this.pending;
    }
    return this.start();
  }

  private start(): Promise<StudioState> {
    if (this.closed) return Promise.reject(new Error("The snapshot builder is closed."));
    this.running = this.build().catch(async (error: unknown) => {
      // An importer owns publication while it replaces a batch. Do not replace
      // the last complete snapshot with an intermediate graph or a stale error.
      if (error instanceof SourceGateError) throw error;
      // evaluate() has already replaced the previous workers. Never leave the
      // previous graph looking current while its preflight workers are gone.
      await this.pool.dispose();
      const previous = this.latest;
      if (!previous) throw error;
      const failure = error as NodeJS.ErrnoException | undefined;
      const code = typeof failure?.code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(failure.code) ? failure.code : undefined;
      const relative = typeof failure?.path === "string" && path.isAbsolute(failure.path) ? path.relative(this.repositoryRoot, failure.path) : undefined;
      const file = relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) ? relative.replaceAll("\\", "/").replace(/[\r\n\t]/g, " ").slice(0, 300) : undefined;
      // Source evaluation has its own diagnostics. This path handles refresh
      // I/O/index failures without copying arbitrary authored exception values.
      const reason = new Error(`Snapshot refresh failed${code ? ` (${code}${file ? `: ${file}` : ""})` : ""}. The last successful graph is retained and cannot be edited. Resolve the refresh failure and refresh Studio.`);
      const dev = failedModel("dev", reason, 0), prod = failedModel("prod", reason, 0);
      const evaluation: Evaluation = { dev, prod, preflight: async () => ({
        dev: { mode: "dev", ok: false, diagnostics: dev.diagnostics },
        prod: { mode: "prod", ok: false, diagnostics: prod.diagnostics },
      }) };
      this.generation += 1;
      const stale = (model: ModeModel, failed: ModeModel): ModeModel => ({ ...model, status: "error", stale: true, diagnostics: failed.diagnostics });
      this.latest = { ...previous, evaluation, snapshot: { ...previous.snapshot,
        revision: `${this.generation}-${sha256(`${previous.snapshot.revision}\n${reason.message}`).slice(0, 12)}`,
        generatedAt: new Date().toISOString(),
        models: { dev: stale(previous.snapshot.models.dev, dev), prod: stale(previous.snapshot.models.prod, prod) },
      } };
      return this.latest;
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * A mode that failed to load keeps showing its last good model, marked stale
   * and carrying the new diagnostics, so a half-typed edit in an editor does
   * not blank the view. A stale model is never edited against.
   */
  private lastGood(fresh: ModeModel): ModeModel {
    const loaded = !(fresh.status === "error" && fresh.targets.length === 0);
    const previous = this.latest?.snapshot.models[fresh.mode];
    if (loaded || !previous || previous.targets.length === 0) return fresh;
    return { ...previous, status: "error", stale: true, diagnostics: fresh.diagnostics, evaluatedInMs: fresh.evaluatedInMs };
  }

  private async build(): Promise<StudioState> {
    releaseAbandonedSourceRead(this.repositoryRoot);
    const publicationEpoch = sourcePublicationEpoch(this.repositoryRoot);
    const files = hashEditableFiles(this.repositoryRoot);
    const evaluation = await this.pool.evaluate();
    const freshDev = this.lastGood(evaluation.dev), freshProd = this.lastGood(evaluation.prod);
    const dev = withAbsentTagging(freshDev, freshProd);
    const prod = withAbsentTagging(freshProd, freshDev);
    const base = !dev.stale && dev.targets.length > 0 ? dev : prod;
    // One parse of each source file serves the index and both modes' evidence.
    const sources = new SourceFiles();
    const built = base.stale && this.latest ? this.latest.built : buildSourceIndex(this.repositoryRoot, base, sources);
    const schema = readDeclaredSchema(this.repositoryRoot);
    const localDatabase = readLocalDatabases(this.repositoryRoot);
    const clientMappings = readClientMappings(this.repositoryRoot);
    const content = sha256(JSON.stringify({ files, conditions: [dev.targets.map(target => target.lanes.when), prod.targets.map(target => target.lanes.when), dev.gateways?.map(gateway => gateway.lanes.when), prod.gateways?.map(gateway => gateway.lanes.when)], schema: schema.hash, localDatabase }));
    // One owner per entity across both graphs, declared in source; structure supplies the rest.
    // Graphs that disagree leave the entity unresolved.
    const metadata = (mode: Mode) => {
      const current = evaluation[mode].targets.length || evaluation[mode].status === "ok" ? evaluation.inputMetadata : this.latest?.evaluation.inputMetadata ?? evaluation.inputMetadata;
      return current?.[mode] ?? EMPTY_INPUT_METADATA;
    };
    const declaredOwnership = mergeDeclaredOwnership([["dev", dev.ownership], ["prod", prod.ownership], ["dev", frameworkSettingOwnership(metadata("dev"))], ["prod", frameworkSettingOwnership(metadata("prod"))]]);
    const stackFiles = Object.fromEntries([...built.catalog].flatMap(([key, entry]) => entry.stack?.location ? [[`resource:${key}`, entry.stack.location.file]] : []));
    const project = (model: ModeModel): ModeModel => {
      const declared = model.stale ? model : withExportStacks(withClassMembers(model, built.catalog, built.index.cdkLinks.edges), built.exportStacks);
      const comparisons = Object.values(clientMappings.mappings).flatMap(mapping => [clientBindingFor(mapping, "dev"), clientBindingFor(mapping, "prod")].flatMap(binding => binding.when ? [binding.when] : []));
      const enriched = withClientEnvironment(withDeploymentInputs(this.repositoryRoot, withLocalDatabases(declared, localDatabase.services), { dev, prod }, comparisons, this.inputSetupProblems(), metadata(model.mode)), clientMappings);
      return withOwnership(withPermissionReadiness(withConnectionAuthorizations(withConnectionEvidence(this.repositoryRoot, enriched, built.index, built.catalog, sources)), built.index), declaredOwnership, { stackFiles });
    };
    const models = { dev: project(dev), prod: project(prod) };
    const snapshot: Snapshot = {
      displayNames: readDisplayNames(this.repositoryRoot),
      namingCapabilities: namingCapabilities(Object.values(models)),
      descriptions: readDescriptions(this.repositoryRoot),
      schema,
      databaseProblems: localDatabase.problems,
      revision: `${this.generation + 1}-${content.slice(0, 12)}`,
      generatedAt: new Date().toISOString(),
      repositoryRoot: this.repositoryRoot,
      application: applicationSummary(this.repositoryRoot),
      models,
      source: built.index,
      files,
    };
    return publishSourceSnapshot(this.repositoryRoot, publicationEpoch, () => {
      // Cache and public graph commit under the same source admission check.
      // A writer cannot acquire a lease between checking the epoch and either write.
      const directory = process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ? path.resolve(process.env.FRAMEWORK_STUDIO_STATE_DIRECTORY) : path.join(this.repositoryRoot, ".cache", "framework-studio");
      mkdirSync(directory, { recursive: true });
      const temporary = path.join(directory, `cdk-links-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, `${JSON.stringify(built.index.cdkLinks, null, 2)}\n`, "utf8");
        replaceFileAtomic(temporary, path.join(directory, "cdk-links.json"));
      } finally { rmSync(temporary, { force: true }); }
      this.generation += 1;
      this.latestEpoch = publicationEpoch;
      // Operations reserve the source whether or not they change it. Republishing
      // what is already published must not read as a source change to a dirty
      // draft, an open review or anything else keyed on the revision.
      const previous = this.latest?.snapshot;
      const unchanged = previous !== undefined && visibleContent(previous) === visibleContent(snapshot);
      this.latest = { snapshot: unchanged ? previous : snapshot, evaluation, built };
      return this.latest;
    });
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.sourceObserver.close();
    return Promise.all([disposeNamingWorkers(this.repositoryRoot), this.evaluators.dispose()]).then(() => undefined);
  }
}
