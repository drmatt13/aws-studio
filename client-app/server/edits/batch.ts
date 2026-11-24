import { planDeploy } from "./deploy";
import { planPrivateZone } from "./private-dns";
import { readPrivateZoneEdit } from "../../shared/private-dns";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmdirSync } from "node:fs";
import path from "node:path";
import { locateConfigSource } from "aws-studio/source-index";
import type { ApplyResponse, BatchPlanResponse, CommentReviewOptions, DraftEdit } from "../../shared/api";
import { currentCommentOptions, reviewedComments, withCommentReview } from "./comments";
import type { ModeModel } from "../../shared/model";
import { inputModeIntents, sameInputModes } from "../../shared/resources";
import { EvaluatorPool } from "../evaluator/pool";
import { assertWritable, hashEditableFiles, sha256, toRelative } from "../files";
import { SnapshotBuilder, type StudioState } from "../snapshot";
import { SourceFiles } from "../source";
import { fieldById } from "./fields";
import { EditError, sourceContents, writeSourceChange } from "aws-studio/source/io";
import { assertCreationFile, creationCapability, planCreation, type CreationExpectation } from "./creation";
import { planPlacement, planNetwork, planNetworkRemoval } from "./networks";
import { planDatabasePlacement, planDatabaseSettings } from "./database";
import { databaseConsumers } from "../../shared/managed-database";
import { generateCreationArtifacts } from "./creation-generation";
import { CreationValidationError } from "../../shared/creation";
import { diffOf, planEdit } from "./plan";
import { formatLiteral } from "./splice";
import { replayHandlerFile, rewriteReplayHandler } from "./local-replay";
import type { RouteChange } from "./route";
import { DESCRIPTION_FILE, connectionDescriptionId, descriptionEntityIds } from "../../shared/descriptions";
import { parseDescriptions, renameRouteDescriptions, rewriteDescription } from "../descriptions";
import { assertResourceFile, planResourceSource, planWorkloadRequirements, resourceTypeErrors } from "../resources-source";
import { namingCapabilities, parseDisplayNames, remapNamingMetadata, rewriteDisplayName } from "../naming-metadata";
import { DISPLAY_NAMES_FILE, type RenameIssue, type RenameSummary } from "../../shared/naming";
import { namingSourceFingerprint } from "../naming-program";
import { planResourceNaming } from "../naming-service";
import { renameEquivalenceSignature } from "../naming-equivalence";
import { namingEntityRemap } from "../naming-continuity";
import { networkSettings } from "../../shared/networks";
import { planFailureDestination, planTriggers, validateTriggerBindings } from "./triggers";
import { triggerTiming } from "../../shared/trigger-availability";
import { assertStackFile, nativeSignature, planNativeRemovals, scanWith } from "./native-triggers";
import { assertOwnershipAllows, assessOwnership, guardedOwner } from "./ownership-guard";
import { ownershipSummaries, planOwnership } from "./ownership";
import { CLIENT_ENVIRONMENT_FILE } from "../../shared/client-environment";
import { parseClientMappings, rewriteClientMappings, validateClientMappings } from "../client-environment-source";

import { planTags, tagSignature, tagOwner, tagDifferences } from "./tags";
import { withAbsentTagging } from "../model/tags";
import { planImplementation } from "./implementation-scaffold";
import type { ScaffoldSnapshot } from "aws-studio/scaffolding";
import { assertStartersUnchanged } from "./scaffolding";
import { planConnection } from "./connections";
import { planWorkloadRemoval } from "./removal";
import { SourceJournal } from "./journal";
import { withSourceWrite } from "aws-studio/source/source-gate";
import { planGatewayOperation } from "./gateways";
import { readWorkloadOperation } from "../../shared/workload-operations";
import { planIdentityPolicy } from "../identity-policy-source";
import { planIamPolicy } from "./iam-policy";
import { presentRelationship } from "../../src/connection-presentation";
import { indexModel } from "../../src/lookup";
import type { ReviewedStructuredSource } from "../agent-runtime/structured-proposal";
import { assertActivatedProjectInstallation, assertCurrentProjectDependencies, assertCurrentProjectInstallation, prepareProjectDependencies, prepareProjectUpgrade, projectUpgradeFile, withReviewedProjectInstallation, type ProjectInstallationReview, type ProjectUpgrade } from "../project-upgrade";
import { resolveProjectInstallation, studioReleaseArchive } from "../project-release";
import { activateInstallation, finishInstallation, restoreInstallation, stageInstallation } from "./installation-journal";

interface Change { readonly file: string; readonly before: string | null; readonly after: string | null }
interface BatchChanges {
  readonly upgrade?: ProjectUpgrade;
  readonly dependencyReview?: ProjectInstallationReview;
  readonly checked?: BatchValidation;
  readonly namingSources?: readonly string[];
  readonly namingFingerprint?: string;
  readonly namingHashes?: Readonly<Record<string, string>>;
  readonly entityRemap?: Readonly<Record<string, string>>;
  readonly namingModels?: Readonly<Record<"dev" | "prod", string>>;
  readonly commentOptions?: CommentReviewOptions;
  readonly label: string;
  readonly changes: readonly Change[];
  readonly edits: readonly DraftEdit[];
  readonly routes: readonly RouteChange[];
  readonly replayTargets: readonly string[];
  readonly replaySources: readonly Change[];
  readonly triggerSources?: Readonly<Record<string, string>>;
  /** Linked CDK stack files written by native trigger removal (absolute paths). */
  readonly cdkSources?: readonly string[];
  readonly creation?: CreationExpectation;
  readonly generatedFiles?: readonly string[];
  readonly generationInputs?: Readonly<Record<string, string>>;
  readonly implementationFiles?: readonly string[];
  readonly templates?: readonly ScaffoldSnapshot[];
  readonly operationModels?: Readonly<Record<"dev" | "prod", string>>;
  readonly networkRemovals?: readonly string[];
  readonly createdDirectories?: readonly string[];
  readonly creationModels?: Readonly<Record<"dev" | "prod", string>>;
}
type BatchValidation = Awaited<ReturnType<BatchEditor["validate"]>>;
interface StoredBatch extends BatchChanges { readonly response: BatchPlanResponse; readonly revision: string; readonly hashes: Record<string, string> }
/** Use the normal review dialog for source, release bytes and install activation. */
function withUpgradeReview(response: BatchPlanResponse, upgrade: ProjectUpgrade): BatchPlanResponse {
  const changes = upgrade.changes.map(({ file, before, after }) => {
    const name = path.basename(file);
    return { file: name, operation: "modify" as const, diff: diffOf(name, before ?? "", after ?? "") };
  });
  const archive = upgrade.archive;
  const binary = archive.alreadyPresent ? [] : [
    { file: archive.file, operation: "create" as const, diff: diffOf(archive.file, "", `npm archive integrity ${archive.integrity}\n`) },
  ];
  return { ...response, activatesDependencies: true,
    summaries: [...response.summaries, `Upgrade framework ${upgrade.previous} → ${upgrade.version}.${upgrade.outcome === "pending" ? " Contract Chain checks passed and receipt approval remains pending." : " Contract Chain checks passed."}`],
    changes: [...response.changes.filter(change => !changes.some(item => item.file === change.file)), ...changes, ...binary],
    impact: [...response.impact, `Use project Node ${upgrade.runtime.version} and npm ${upgrade.runtime.npmVersion} to install and verify the approved dependencies offline. Apply activates them with the source and framework archive.`],
  };
}

/** Compare framework semantics, excluding source locations and Inspector enrichments. */
function creationSignature(model: ModeModel): string {
  return JSON.stringify({ targets: model.targets.map(({ ref, constructId, role, lanes, environment, secrets, placement, compute, access, requirementRules, authoredRequirementRules }) => ({ ref, constructId, role, lanes, environment, secrets, placement, compute, access, requirementRules, authoredRequirementRules })), routes: model.routes,
    // Compare this graph's resolved policy. The snapshot additionally enriches
    // every input with a two-mode inspector table; evaluators omit that table
    // when both graphs agree, and each graph is verified separately below.
    resources: model.resources.filter((resource) => ["input", "secret", "stack"].includes(resource.kind) && resource.id.startsWith("resource:")).map(({ id, kind, absent, fromEnv, default: fallback, authoredValue, required, values, note }) => ({ id, kind, absent, fromEnv, fallback, authoredValue, required, values, note })),
    gateways: model.gateways?.filter(gateway => gateway.protocol === "agentcore"),
    workflows: model.workflows, tagging: tagSignature(model),
    // Native CDK usage is added by the source index after evaluation. Compare
    // authored settings here, independently of that source-only enrichment.
    networks: model.networks?.map(({ builtInProd, ...network }) => network), privateHostedZones: model.privateHostedZones, databaseNetworkId: model.databaseNetworkId,
    managedDatabase: model.managedDatabase,
    edges: model.edges.filter((edge) => edge.provenance === "declared" && edge.relation !== "database").map(({ relation, from, to, label, attachment }) => ({ relation, from, to, label, attachment })),
  });
}
function cleanupCreatedDirectories(entry: BatchChanges): void {
  for (const directory of [...(entry.createdDirectories ?? [])].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
}
const identity = (model: ModeModel) => JSON.stringify([...model.targets.map(target => [target.ref, target.constructId]), ...(model.gateways ?? []).flatMap(gateway => gateway.protocol === "agentcore" ? [[gateway.id, gateway.constructId]] : [])].sort((a, b) => a[0]!.localeCompare(b[0]!)));

/** Snapshot evidence describes source locations; it does not change a binding's semantics. */
export function connectionSignature(model: Pick<ModeModel, "edges">): string {
  return JSON.stringify(model.edges.filter(edge => edge.provenance !== "source" && ["grant", "runsTask", "startsWorkflow", "invokesAgent", "usesGateway", "usesTool"].includes(edge.relation))
    .map(({ evidence: _evidence, authorization: _authorization, readinessIssues: _readiness, ...edge }) => edge));
}

/** Composes the existing literal splices in memory, then validates the final source once.
 * Its journal is owned by EditService, alongside the existing single-edit journal. */
export class BatchEditor {
  private readonly plans = new Map<string, StoredBatch>();
  private readonly journal: SourceJournal;
  constructor(private readonly root: string, private readonly builder: SnapshotBuilder, private readonly ownWrites: Map<string, string>, private readonly writeFile = writeSourceChange) { this.journal = new SourceJournal(root); }
  expirePlans(): void { this.plans.clear(); }
  private state(): StudioState {
    if (!this.builder.current) throw new EditError(503, "The configuration has not loaded yet.");
    return this.builder.current;
  }
  private unchanged(revision: string, hashes: Record<string, string>, ...sourceGroups: readonly (Readonly<Record<string, string>> | undefined)[]): void {
    if (this.state().snapshot.revision !== revision || JSON.stringify(hashEditableFiles(this.root)) !== JSON.stringify(hashes)) throw new EditError(409, "Source files changed during this editing session. Your draft is preserved; discard it to load the latest configuration.");
    for (const sources of sourceGroups) for (const [file, hash] of Object.entries(sources ?? {})) {
      let actual: string | undefined;
      try { actual = sha256(readFileSync(path.join(this.root, file), "utf8")); } catch { /* A removed source also expires the review. */ }
      if (actual !== hash) throw new EditError(409, `${file} changed after review. Review against the latest source; existing implementation and generated inputs must match the accepted proposal.`);
    }
  }
  plan(edits: readonly DraftEdit[], revision: string, options?: CommentReviewOptions): Promise<BatchPlanResponse> {
    return withCommentReview(this.root, options, () => this.planSource(edits, revision));
  }
  private async planFrameworkUpgrade(edit: Extract<DraftEdit, { kind: "frameworkUpgrade" }>, revision: string, hashes: Record<string, string>, state: StudioState): Promise<BatchPlanResponse> {
    const prepared = await prepareProjectUpgrade(this.root, async (candidate) => {
      const builder = new SnapshotBuilder(candidate, undefined, undefined, this.builder.conditionInputRoot);
      try {
        const next = new BatchEditor(candidate, builder, new Map());
        const checked = await next.validate({}, state, []);
        if (!checked.preflight.dev.ok || !checked.preflight.prod.ok) throw new EditError(422, "The target framework changed application identities or failed preflight. Resolve the application checks before upgrading.");
        return { changes: [], result: checked };
      } finally { await builder.dispose(); }
    });
    if (!prepared?.result) throw new EditError(422, "This project already uses the bundled framework release or a newer one.");
    const { upgrade, result: checked } = prepared;
    this.unchanged(revision, hashes);
    const response = withUpgradeReview({ planId: randomUUID(), summaries: [], changes: [], preflight: checked.preflight, ok: true, impact: [] }, upgrade);
    this.plans.set(response.planId, { upgrade, checked, label: `Upgrade framework to ${upgrade.version}`, response, revision, hashes, changes: upgrade.changes, edits: [edit], routes: [], replayTargets: [], replaySources: [] });
    return response;
  }
  private async planCreationUpgrade(edit: Extract<DraftEdit, { kind: "create" }>, revision: string, hashes: Record<string, string>): Promise<BatchPlanResponse> {
    const capability = creationCapability(edit.request)!;
    const supplied = studioReleaseArchive();
    if (!supplied.compatibility.capabilities.includes(capability.feature)) {
      throw new EditError(422, `${capability.field}: ${capability.label} requires a Studio installation with a compatible framework release.`);
    }
    const prepared = await prepareProjectUpgrade(this.root, async (candidateRoot) => {
      const builder = new SnapshotBuilder(candidateRoot, undefined, undefined, this.builder.conditionInputRoot);
      try {
        const { snapshot } = await builder.refresh();
        const editor = new BatchEditor(candidateRoot, builder, new Map());
        const response = await withCommentReview(candidateRoot, currentCommentOptions(),
          () => editor.planSource([edit], snapshot.revision, true));
        if (!response.ok) {
          const diagnostics = Object.values(response.preflight).flatMap(mode => mode.diagnostics)
            .filter(item => item.severity === "error").map(item => item.message);
          throw new EditError(422, [...new Set(diagnostics)].join("\n") || "The feature candidate did not pass source review.");
        }
        const planned = editor.plans.get(response.planId)!;
        const toLive = (file: string) => path.join(this.root, toRelative(candidateRoot, file));
        const changes = planned.changes.map(change => ({ ...change, file: toLive(change.file) }));
        // The candidate deliberately has a different framework and lock. The
        // installation review guards live dependency bytes and the staged tree.
        const againstLive = (inputs?: Readonly<Record<string, string>>) => inputs && Object.fromEntries(
          Object.entries(inputs).filter(([file]) => file !== "package.json" && file !== "package-lock.json" && !file.split("/").includes("node_modules")),
        );
        const result = { ...planned, changes, revision, hashes,
          createdDirectories: planned.createdDirectories?.map(toLive),
          generatedFiles: planned.generatedFiles?.map(toLive),
          implementationFiles: planned.implementationFiles?.map(toLive),
          generationInputs: againstLive(planned.generationInputs),
          triggerSources: againstLive(planned.triggerSources),
        };
        return { changes, result };
      } finally {
        await builder.dispose();
      }
    });
    if (!prepared?.result) throw new EditError(422, `${capability.field}: ${capability.label} requires a newer framework that declares support for this feature.`);
    const { result, upgrade } = prepared;
    this.unchanged(revision, hashes, result.triggerSources, result.generationInputs);
    const response = withUpgradeReview(result.response, upgrade);
    const changes = result.changes.filter(change => !upgrade.changes.some(item => item.file === change.file));
    this.plans.set(response.planId, { ...result, response, upgrade, changes: [...changes, ...upgrade.changes] });
    return response;
  }
  private async planSource(edits: readonly DraftEdit[], revision: string, frameworkCandidate = false): Promise<BatchPlanResponse> {
    const state = this.state();
    let triggerSources = edits.some((edit) => edit.kind === "iamPolicy" || edit.kind === "connection" || edit.kind === "triggers" || edit.kind === "nativeTrigger" || edit.kind === "onFailure") ? state.snapshot.source.capabilityFiles : undefined;
    const hashes = hashEditableFiles(this.root);
    this.unchanged(revision, state.snapshot.files, triggerSources);
    if (!edits.length || edits.length > 100) throw new EditError(400, "Review between 1 and 100 setting changes together.");
    if (Object.values(state.snapshot.models).some((model) => model.stale || model.status === "error")) throw new EditError(422, this.builder.sourceHold ?? "Fix configuration errors before reviewing changes.");
    const upgrade = edits.find(edit => edit.kind === "frameworkUpgrade");
    if (upgrade) {
      if (edits.length !== 1) throw new EditError(422, "Review an explicit framework upgrade on its own.");
      return this.planFrameworkUpgrade(upgrade, revision, hashes, state);
    }
    const creationEdit = edits.find((edit) => edit.kind === "create");
    if (creationEdit && edits.length !== 1) throw new EditError(422, "Review each resource creation as one complete operation.");
    if (creationEdit?.kind === "create") {
      const capability = creationCapability(creationEdit.request);
      if (capability && !resolveProjectInstallation(this.root).compatibility.capabilities.includes(capability.feature)) {
        return this.planCreationUpgrade(creationEdit, revision, hashes);
      }
    }
    if (edits.some(edit => edit.kind === "removeNetwork") && edits.length !== 1) throw new EditError(422, "Review a VPC removal on its own. Reassign its consumers first.");
    let creation: ReturnType<typeof planCreation> | undefined;
    if (creationEdit?.kind === "create") {
      try { creation = planCreation(this.root, state, creationEdit.request); }
      catch (error) { if (error instanceof CreationValidationError) throw new EditError(422, `${error.field}: ${error.message}`); throw error; }
    }
    const model = state.snapshot.models.dev;
    const overrides = new Map<string, string>(creation?.overrides);
    const namingSources = new Set<string>();
    let namingFingerprint: string | undefined;
    let namingHashes: Readonly<Record<string, string>> | undefined;
    let entityRemap: Readonly<Record<string, string>> | undefined;
    let rename: RenameSummary | undefined;
    const renameIssues: RenameIssue[] = [];
    const renames = edits.filter(edit => edit.kind === "rename");
    if (renames.length > 1) throw new EditError(422, "Review one code rename per draft.");
    if (renames.length && edits.some(edit => ["create", "removeWorkload", "removeNetwork", "removeGateway"].includes(edit.kind))) throw new EditError(422, "Review creation or removal separately from a code rename.");
    const moves: { entity: string; path: readonly string[] }[] = [];
    for (const edit of edits) if (edit.kind === "resourceConfig") {
      if (edits.filter(item => item.kind === "resourceConfig" && item.intent.resource === edit.intent.resource).length !== 1) throw new EditError(422, "Review one configuration change per input.");
      const resource = Object.values(state.snapshot.models).flatMap(model => model.resources).find(resource => resource.id === edit.intent.resource && !resource.absent)
        ?? model.resources.find(resource => resource.id === edit.intent.resource);
      if (!resource || !["input", "secret"].includes(resource.kind) || !resource.inputChoices && !namingCapabilities(Object.values(state.snapshot.models))[resource.id]?.code) throw new EditError(422, "Select an authored input or secret to edit its configuration.");
      const oldGroup = resource.path.slice(0, -1).join(".");
      if (resource.frameworkInput && guardedOwner(state, resource.id) !== "developer") throw new EditError(422, "The framework input declaration must be developer-owned to edit its behavior.");
      if (resource.frameworkInput && (edit.intent.group !== oldGroup || edit.intent.fromEnv !== undefined && edit.intent.fromEnv !== resource.fromEnv || edit.intent.kind !== resource.kind)) throw new EditError(422, "Framework input edits must preserve the reader, variable name and group.");
      if (oldGroup !== edit.intent.group) moves.push({ entity: resource.id, path: [...(edit.intent.group ? [edit.intent.group] : []), resource.path.at(-1)!] });
      const references = edit.intent.kind !== resource.kind ? await planResourceNaming(this.root, state, { kind: "references", entity: resource.id }, overrides) : undefined;
      const referenceIssues = references?.issues ?? [];
      if (edit.intent.kind !== resource.kind) {
        namingFingerprint = references!.sourceFingerprint; namingHashes = references!.sourceHashes;
        renameIssues.push(...referenceIssues);
      }
      try {
        const planned = planResourceSource(this.root, state, resource, { ...edit.intent, group: oldGroup }, overrides, true, referenceIssues.length > 0);
        for (const [file, text] of Object.entries(planned.overrides)) { overrides.set(file, text); if (!toRelative(this.root, file).startsWith("framework-config/")) namingSources.add(file); }
      } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
    }
    try {
      const intents = edits.flatMap(edit => edit.kind === "resourceConfig" ? [edit.intent] : []);
      if (intents.some(intent => Object.keys(intent.requirements).length)) {
        for (const [file, text] of Object.entries(planWorkloadRequirements(this.root, state, intents, overrides))) overrides.set(file, text);
      }
    } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
    if (moves.length > 1 || moves.length && renames.length) throw new EditError(422, "Review one group move at a time, separately from a code rename.");
    const deletions = new Map<string, Change>();
    const creationBefore = new Map(creation?.before);
    let generationInputs: Readonly<Record<string, string>> | undefined;
    const generatedFiles = new Set<string>();
    const implementationFiles = new Set<string>();
    const templates = [...(creation?.templates ?? [])];
    const policyFiles = new Set<string>();
    if (creation) {
      const generated = await generateCreationArtifacts(this.root, overrides);
      for (const [file, text] of generated.overrides) overrides.set(file, text);
      for (const [file, text] of generated.before) creationBefore.set(file, text);
      for (const [file, before] of generated.deletions) deletions.set(file, { file, before, after: null });
      for (const file of [...generated.overrides.keys(), ...generated.deletions.keys()]) generatedFiles.add(file);
      generationInputs = generated.inputs;
      triggerSources = { ...state.snapshot.source.capabilityFiles, ...triggerSources, ...generated.inputs };
      this.unchanged(revision, hashes, triggerSources);
    }
    const seen = new Set<string>();
    const summaries: string[] = [];
    const replayTargets: string[] = [];
    const handlerBefore = new Map<string, string>();
    // Changing who maintains a definition is its own reviewed transition, never part of an edit.
    if (edits.some(edit => edit.kind === "ownership") && edits.some(edit => edit.kind !== "ownership")) throw new EditError(422, "An ownership change is reviewed on its own. Apply or discard the other staged changes first.");
    const transitionTargets = new Set<string>();
    for (const edit of edits) {
      if (edit.kind === "frameworkUpgrade") continue;
      if (edit.kind === "privateZone") {
        const decoded = readPrivateZoneEdit(edit);
        const key = `privateZone:${decoded.id}`;
        if (seen.has(key)) throw new EditError(400, "Review one complete change per private zone.");
        seen.add(key);
        const planned = planPrivateZone(this.root, state, decoded, overrides);
        for (const file of planned.files) implementationFiles.add(file);
        for (const change of planned.deletions) { overrides.delete(change.file); deletions.set(change.file, change); }
        summaries.push(`${decoded.operation === "create" ? "Create" : decoded.operation === "remove" ? "Remove" : "Configure"} private hosted zone ${decoded.id}`);
        continue;
      }
      if (edit.kind === "rename") continue;
      if (edit.kind === "resourceConfig") { summaries.push(`${edit.intent.resource} — update input configuration`); continue; }
      if (edit.kind === "displayName") {
        if (edits.filter(item => item.kind === "displayName" && item.entity === edit.entity).length !== 1) throw new EditError(422, "Review one display name per resource.");
        if (!namingCapabilities(Object.values(state.snapshot.models))[edit.entity]?.display) throw new EditError(404, "Select a managed map item to edit its display name.");
        try {
          if (edit.entity.startsWith("island:vpc:")) {
            const id = edit.entity.slice("island:vpc:".length);
            const network = Object.values(state.snapshot.models).flatMap(model => model.networks ?? []).find(network => network.id === id)!;
            const pending = edits.find(edit => edit.kind === "network" && edit.network === id);
            const settings = pending?.kind === "network" ? pending.settings : networkSettings(network);
            const planned = planNetwork(this.root, state, id, { ...settings, name: edit.value?.trim() || id }, new SourceFiles(overrides));
            overrides.set(planned.file, planned.after);
          } else {
            const file = assertCreationFile(this.root, DISPLAY_NAMES_FILE);
            const before = overrides.get(file) ?? sourceContents(file);
            if (before !== null || edit.value?.trim()) overrides.set(file, rewriteDisplayName(before, edit.entity, edit.value));
          }
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
        summaries.push(`${edit.entity} — ${edit.value?.trim() ? `display as ${JSON.stringify(edit.value.trim())}` : "restore automatic name"}`);
        continue;
      }
      if (edit.kind === "agentGateways" || edit.kind === "gatewayTools" || edit.kind === "gatewayDeploy" || edit.kind === "removeGateway") {
        const key = `${edit.kind}:${edit.kind === "agentGateways" ? edit.target : edit.gateway}`;
        if (seen.has(key)) throw new EditError(400, "Review one complete change per Gateway setting.");
        seen.add(key);
        planGatewayOperation(this.root, state, edit, overrides);
        summaries.push(edit.kind === "agentGateways" ? `${edit.target} — select AgentCore gateways in order: ${edit.gateways.join(", ") || "none"}`
          : edit.kind === "gatewayTools" ? `${edit.gateway} — expose Lambda tools: ${edit.tools.join(", ") || "none"}`
          : edit.kind === "gatewayDeploy" ? `${edit.gateway} — update Gateway deployment`
          : `Remove ${edit.gateway} declaration. Deployed infrastructure requires a separate deployment review.`);
        continue;
      }
      if (edit.kind === "deploy") {
        if (edits.filter(item => item.kind === "deploy" && item.target === edit.target || item.kind === "field" && item.intent.target === edit.target && item.intent.field === "deploy").length !== 1) throw new EditError(422, "Review one Deploy change per workload.");
        planDeploy(this.root, state, edit, overrides);
        summaries.push(`${edit.target} — ${typeof edit.value === "string" ? `Deploy ${edit.value}` : `Deploy only when ${edit.value.when.resource} matches ${JSON.stringify(edit.value.when.equals)}`}`);
        continue;
      }
      if (edit.kind === "identityPolicy") {
        if (edits.filter(item => item.kind === "identityPolicy" && item.target === edit.target).length !== 1) throw new EditError(422, "Review one policy change per identity-pool stack.");
        const policy = planIdentityPolicy(this.root, state, edit, overrides);
        policyFiles.add(policy.file); triggerSources = { ...triggerSources, ...policy.hashes };
        summaries.push(`${edit.target} — replace ReaderRole policy with ${edit.statements.length} explicit Allow/Deny statements; permissionless guests ${edit.allowUnauthenticated ? "enabled" : "disabled"}; default authenticated role and its trust stay unchanged`);
        continue;
      }
      if (edit.kind === "iamPolicy") {
        if (edits.filter(item => item.kind === "iamPolicy" && item.rule && item.rule === edit.rule).length > 1) throw new EditError(422, "Review one complete change per owning IAM rule.");
        planIamPolicy(this.root, state, edit, overrides);
        const rule = state.snapshot.source.policyRules?.find(rule => rule.id === edit.rule);
        summaries.push(`${edit.target} — ${edit.operation} explicit IAM policy${rule?.shared ? ` shared by ${rule.consumers.join(", ")}` : ""}`);
        continue;
      }
      if (["implementation", "connection", "removeWorkload"].includes(edit.kind)) readWorkloadOperation(edit);
      if (edit.kind === "create") { summaries.push(`Create ${edit.request.kind}: ${creation!.expected.select}`); continue; }
      if (edit.kind === "implementation") {
        const target = Object.values(state.snapshot.models).flatMap(model => model.targets).find(target => target.ref === edit.target);
        if (!target) throw new EditError(404, "Select a declared workload to repair its implementation.");
        const implementation = planImplementation(this.root, target);
        templates.push(...implementation.templates);
        for (const [file, text] of implementation.files) { overrides.set(file, text); creationBefore.set(file, null); implementationFiles.add(file); }
        summaries.push(`${edit.target} — create missing starter files at ${target.directory}; existing files are preserved`);
        continue;
      }
      if (edit.kind === "connection") {
        planConnection(this.root, state, edit, overrides);
        const purpose = edit.connection === "resourceAccess" ? `application access: ${edit.actions?.join(", ")}${edit.limits?.objectPrefix ? ` · prefix ${edit.limits.objectPrefix}` : ""}${edit.limits?.requireHttps ? " · HTTPS required" : ""}`
          : edit.connection === "grant" ? `native IAM ${edit.grant}(${edit.scope ? JSON.stringify(edit.scope) : ""})`
          : edit.connection === "database" ? "database IAM login, endpoints and network placement"
          : edit.connection === "runsTask" ? "ECS launch and role-passing grants"
          : edit.connection === "startsWorkflow" ? "workflow start grant"
          : edit.connection === "invokesAgent" ? "agent invocation binding (IAM or user token, from agent auth)"
          : edit.connection === "resource" ? "input/secret delivery (typed secrets include read grants)" : "user-pool identifier delivery";
        summaries.push(`${edit.target} — ${edit.enabled ? "add" : "remove"} ${purpose}${edit.destination ? ` → ${edit.destination}` : ""}`);
        continue;
      }
      if (edit.kind === "removeWorkload") {
        for (const change of planWorkloadRemoval(this.root, state, edit.target, overrides)) { deletions.set(change.file, change); implementationFiles.add(change.file); }
        for (const file of overrides.keys()) if (toRelative(this.root, file).startsWith("archived-workloads/")) implementationFiles.add(file);
        triggerSources = state.snapshot.source.capabilityFiles;
        summaries.push(`Remove ${edit.target} declaration and archive its implementation under archived-workloads. Deployed AWS resources and data require a separate removal review.`); continue;
      }
      const key = edit.kind === "tags" ? `tags:${tagOwner(model, edit.entity)}` : edit.kind === "ownership" ? `ownership:${tagOwner(model, edit.entity)}` : edit.kind === "databasePlacement" ? `databasePlacement:${edit.database}` : edit.kind === "database" ? `database:${edit.database}` : edit.kind === "removeNetwork" ? `removeNetwork:${edit.network}` : edit.kind === "placement" ? `placement:${edit.target}` : edit.kind === "network" ? `network:${edit.network}` : edit.kind === "clientEnvironment" ? "clientEnvironment" : edit.kind === "field" ? `${edit.intent.target}:${edit.intent.field}` : edit.kind === "description" ? `description:${edit.entity}` : edit.kind === "triggers" ? `triggers:${edit.event}` : edit.kind === "onFailure" ? `onFailure:${edit.event}` : edit.kind === "nativeTrigger" ? `native:${edit.edge}` : edit.route;
      if (seen.has(key)) throw new EditError(400, "A draft can change each setting only once.");
      seen.add(key);
      if (edit.kind === "tags") {
        planTags(this.root, model, edit.entity, edit.tags, overrides);
        summaries.push(`${edit.entity} — update declaration tags`);
      }
      if (edit.kind === "ownership") {
        const planned = planOwnership(this.root, model, edit.entity, edit.managedBy, overrides);
        for (const id of planned.targets) transitionTargets.add(id);
        summaries.push(...ownershipSummaries(model, edit.entity, edit.managedBy, planned.targets));
      }
      if (edit.kind === "databasePlacement") {
        const consumers = databaseConsumers(Object.values(state.snapshot.models), edit.database);
        if (edits.some(item => item.kind === "placement" && consumers.some(consumer => consumer.target === item.target))) throw new EditError(422, "A coordinated database placement already includes its connected workloads. Remove their separate placement changes and review again.");
        const moved = planDatabasePlacement(this.root, state, edit, overrides);
        summaries.push(`Application database ${edit.database} — ${edit.vpc} VPC, ${edit.subnet} subnets${moved.length ? `; update ${moved.length} connected workloads` : ""}`);
      }
      if (edit.kind === "database") {
        const planned = planDatabaseSettings(this.root, state, edit.database, edit.settings, new SourceFiles(overrides));
        overrides.set(planned.file, planned.after);
        summaries.push(`Database ${edit.database} — update PostgreSQL infrastructure settings`);
      }
      if (edit.kind === "removeNetwork") {
        for (const change of planNetworkRemoval(this.root, state, edit.network, new SourceFiles(overrides))) {
          if (change.after === null) deletions.set(change.file, change);
          else overrides.set(change.file, change.after);
        }
        summaries.push(`Remove unused VPC ${edit.network} and its declaration`);
      }
      if (edit.kind === "placement") {
        planPlacement(this.root, state, edit, overrides);
        summaries.push(`${edit.target} — ${edit.vpc ? `VPC ${edit.vpc}, ${edit.subnet}` : "outside VPCs"}`);
      }
      if (edit.kind === "network") {
        const name = edits.find(item => item.kind === "displayName" && item.entity === `island:vpc:${edit.network}`);
        const planned = planNetwork(this.root, state, edit.network, { ...edit.settings, ...(name?.kind === "displayName" ? { name: name.value?.trim() || edit.network } : {}) }, new SourceFiles(overrides));
        overrides.set(planned.file, planned.after);
        summaries.push(`VPC ${edit.network} — update network settings`);
      }
      if (edit.kind === "clientEnvironment") {
        const file = assertWritable(this.root, CLIENT_ENVIRONMENT_FILE);
        try {
          validateClientMappings(edit.mappings, Object.values(state.snapshot.models));
          overrides.set(file, rewriteClientMappings(new SourceFiles(overrides).text(file), edit.mappings));
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
        summaries.push("Update client-app environment mappings");
      }
      if (edit.kind === "triggers") {
        try {
          const planned = planTriggers(this.root, state, edit.event, edit.bindings, new SourceFiles(overrides));
          overrides.set(planned.file, planned.after);
          summaries.push(`${edit.event} — update triggers`);
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (edit.kind === "onFailure") {
        try {
          const planned = planFailureDestination(this.root, state, edit.event, edit.value, new SourceFiles(overrides));
          overrides.set(planned.file, planned.after);
          summaries.push(`${edit.event} — ${edit.value ? "set" : "remove"} failure destination`);
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      if (edit.kind === "description") {
        if (!descriptionEntityIds(Object.values(state.snapshot.models)).has(edit.entity)) throw new EditError(404, "Select a managed map item to edit its description.");
        const file = assertWritable(this.root, DESCRIPTION_FILE);
        try { overrides.set(file, rewriteDescription(new SourceFiles(overrides).text(file), edit.entity, edit.value)); }
        catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
        const connection = Object.values(state.snapshot.models).map(model => ({ model, edge: model.edges.find(edge => connectionDescriptionId(edge) === edit.entity) })).find(item => item.edge);
        summaries.push(`${connection?.edge ? `${presentRelationship(connection.edge, indexModel(connection.model)).title} connection (${connection.edge.from} → ${connection.edge.to})` : edit.entity} — update description`);
      }
      if (edit.kind !== "field") continue;
      const { intent } = edit;
      const field = fieldById(intent.field);
      const fact = model.fields[intent.target]?.find((fact) => fact.field === intent.field);
      const origin = model.defaults?.find((group) => group.ref === intent.target)?.origin ?? model.targets.find((target) => target.ref === intent.target)?.origins[0];
      if (!field || !fact || !origin) throw new EditError(404, `${intent.target} has no editable setting ${intent.field}.`);
      const result = planEdit({ repositoryRoot: this.root, origin, field, fact, intent, files: new SourceFiles(overrides) });
      if ("refused" in result) throw new EditError(422, result.refused);
      assertWritable(this.root, result.planned.relativeFile);
      overrides.set(result.planned.file, result.planned.after);
      if (field.id === "events.localReplay") {
        const target = model.targets.find((target) => target.ref === intent.target)!;
        try {
          const { file, name } = replayHandlerFile(this.root, target);
          if (handlerBefore.has(file)) throw new Error("These events share a handler. Update their local replay settings together in source.");
          const before = new SourceFiles(overrides).text(file);
          handlerBefore.set(file, before);
          overrides.set(file, rewriteReplayHandler(file, before, name, !intent.inherit && intent.value === true));
          replayTargets.push(target.ref);
        } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      }
      summaries.push(`${intent.target} — ${result.planned.summary}`);
    }
    const nativeEdits = edits.flatMap((edit) => edit.kind === "nativeTrigger" ? [edit.edge] : []);
    let native: ReturnType<typeof planNativeRemovals> | undefined;
    if (nativeEdits.length) {
      try { native = planNativeRemovals(this.root, state, nativeEdits, new SourceFiles(overrides)); }
      catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
      for (const [file, after] of native.changes) overrides.set(file, after);
      for (const edge of native.removed) summaries.push(`${edge.to.replace(/^lambda:/, "")} — remove native ${edge.label} (${edge.source!.file}:${edge.source!.line})`);
    }
    // Rename all public keys together, after field splices, so aliases can swap paths
    // without rejecting a temporary duplicate or losing a preceding field edit.
    const files = new SourceFiles(overrides);
    const located = locateConfigSource(path.join(this.root, "framework.config.ts"), { repositoryRoot: this.root, host: files.host() });
    const replacements = new Map<string, { start: number; end: number; value: string }[]>();
    const routes: RouteChange[] = [];
    for (const edit of edits) {
      if (edit.kind !== "route") continue;
      const route = model.routes.find((route) => route.id === edit.route);
      if (!route || route.kind !== "http") throw new EditError(404, "Select an HTTP Lambda route.");
      if (!edit.value.startsWith("/") || edit.value.trim() !== edit.value || /[\r\n\0]/.test(edit.value)) throw new EditError(422, "A route must start with / and have no surrounding whitespace.");
      const entry = located.sections.http.find((entry) => entry.key === route.path);
      if (!entry) throw new EditError(422, "This route could not be located in source.");
      const quote = files.text(entry.file)[entry.keySpan.start];
      if (quote !== '"' && quote !== "'") throw new EditError(422, "Computed route keys must be edited in source.");
      const list = replacements.get(entry.file) ?? [];
      list.push({ start: entry.keySpan.start, end: entry.keySpan.end, value: formatLiteral(edit.value, quote) });
      replacements.set(entry.file, list);
      routes.push({ before: route.path, after: edit.value, target: route.target });
      summaries.push(`Route: ${route.path} → ${edit.value}`);
    }
    for (const [file, edits] of replacements) {
      assertWritable(this.root, toRelative(this.root, file));
      let text = files.text(file);
      for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
      overrides.set(file, text);
    }
    const descriptionFile = path.join(this.root, DESCRIPTION_FILE);
    if (routes.length && state.snapshot.files[DESCRIPTION_FILE]) {
      assertWritable(this.root, DESCRIPTION_FILE);
      try {
        const before = new SourceFiles(overrides).text(descriptionFile);
        const after = renameRouteDescriptions(before, routes);
        if (after !== before) overrides.set(descriptionFile, after);
      } catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
    }
    const beforeNaming = new Map(overrides);
    const codeRename = renames[0];
    if (codeRename?.kind === "rename" || moves.length) {
      if (codeRename?.kind === "rename" && !namingCapabilities(Object.values(state.snapshot.models))[codeRename.entity]?.code) throw new EditError(422, "This resource supports display-name editing. Its code identity requires compatibility checks before it can be renamed.");
      const planned = await planResourceNaming(this.root, state, codeRename?.kind === "rename"
        ? { kind: "rename", entity: codeRename.entity, name: codeRename.name }
        : { kind: "move", entity: moves[0]!.entity, nextPath: moves[0]!.path }, overrides);
      entityRemap = planned.entityRemap;
      namingFingerprint = planned.sourceFingerprint; namingHashes = planned.sourceHashes;
      for (const file of planned.sourceFiles) namingSources.add(file);
      renameIssues.push(...planned.issues);
      const from = codeRename?.kind === "rename" ? codeRename.entity : moves[0]!.entity;
      const to = entityRemap[from];
      if (to) {
        for (const file of [DESCRIPTION_FILE, DISPLAY_NAMES_FILE] as const) {
          try {
            const absolute = assertCreationFile(this.root, file), before = overrides.get(absolute) ?? sourceContents(absolute);
            if (before !== null) { const after = remapNamingMetadata(before, file, entityRemap); if (after !== before) overrides.set(absolute, after); }
          } catch (error) { renameIssues.push({ message: error instanceof Error ? error.message : String(error), source: { file, line: 1, column: 1, start: 0, end: 0 } }); }
        }
        rename = { from, to, referenceCount: planned.referenceCount, fileCount: [...overrides].filter(([file, after]) => sourceContents(file) !== after).length };
        summaries.push(`${from} → ${to} — update code references and naming associations`);
      }
    }
    if (!renameIssues.length && !deletions.size && [...overrides].every(([file, after]) => sourceContents(file) === after)) throw new EditError(422, "This draft has no source changes.");
    // Refuse a change to a framework-managed definition before generating or evaluating anything.
    assertOwnershipAllows(this.root, state, [...[...overrides].map(([file, after]) => ({ file, before: sourceContents(file), after })), ...deletions.values()]);
    let generationFailure: { error: unknown } | undefined;
    if (!creation && !renameIssues.length && (edits.some(edit => !["identityPolicy", "description", "displayName", "rename", "resourceConfig", "tags", "ownership", "clientEnvironment", "network", "database", "databasePlacement", "placement", "removeNetwork", "privateZone"].includes(edit.kind)) || entityRemap && Object.keys(entityRemap).length && existsSync(path.join(this.root, "package.json")))) {
      // Generate in the private copy first, then validate the exact final overlay
      // once. A second full evaluation of the same candidate provided no extra
      // authority; Apply still revalidates it and checks the written models.
      let generated: Awaited<ReturnType<typeof generateCreationArtifacts>> | undefined;
      try { generated = await generateCreationArtifacts(this.root, overrides, [...deletions.keys()]); }
      catch (error) { generationFailure = { error }; }
      if (generated) {
        for (const [file, text] of generated.overrides) overrides.set(file, text);
        for (const [file, text] of generated.before) creationBefore.set(file, text);
        for (const [file, before] of generated.deletions) deletions.set(file, { file, before, after: null });
        for (const file of [...generated.overrides.keys(), ...generated.deletions.keys()]) generatedFiles.add(file);
        generationInputs = generated.inputs;
        this.unchanged(revision, hashes, generated.inputs);
      }
    }
    const changes: Change[] = [...[...overrides].map(([file, after]) => ({ file, before: creationBefore.has(file) ? creationBefore.get(file)! : handlerBefore.get(file) ?? sourceContents(file), after })), ...deletions.values()].filter((change) => change.before !== change.after);
    if (creation) for (const change of changes) {
      assertCreationFile(this.root, toRelative(this.root, change.file));
      if (sourceContents(change.file) !== change.before) throw new EditError(409, `${toRelative(this.root, change.file)} changed during creation review. No files were written.`);
    }
    if (!changes.length && !renameIssues.length) throw new EditError(422, "This draft has no source changes.");
    // Definitions Studio does not own stay as written, whichever edit produced this change,
    // and only an explicit ownership edit may change who owns one.
    const transitions = assessOwnership(this.root, state, changes);
    const unrequested = transitions.find(transition => !transitionTargets.has(transition.entity));
    if (unrequested) throw new EditError(422, `This change would alter ${unrequested.entity}'s ownership (${unrequested.from} → ${unrequested.to}) without an ownership review. Change ownership on its own first.`);
    // Removing native wiring must take away exactly the selected triggers and nothing else.
    const expectedNative = native && (() => {
      const remaining = nativeSignature(state.snapshot.source.cdkLinks);
      for (const edge of native.removed) remaining.splice(remaining.indexOf(`trigger|${edge.from}|${edge.to}|${edge.label}|${edge.source?.file}`), 1);
      return remaining;
    })();
    const checked = await this.validate(Object.fromEntries(overrides), state, routes, expectedNative, creation?.expected, edits.flatMap(edit => edit.kind === "removeWorkload" ? [edit.target] : edit.kind === "removeGateway" ? [edit.gateway] : []), [...deletions.keys()], !!entityRemap || edits.some(edit => edit.kind === "resourceConfig" || edit.kind === "iamPolicy"));
    if (entityRemap && Object.keys(entityRemap).length && !renameIssues.length && checked.preflight.dev.ok && checked.preflight.prod.ok) {
      const pool = new EvaluatorPool(this.root, undefined, this.builder.evaluators, undefined, this.builder.conditionInputRoot);
      try {
        const evaluated = await pool.evaluate(Object.fromEntries(beforeNaming));
        const before = { dev: withAbsentTagging(evaluated.dev, evaluated.prod), prod: withAbsentTagging(evaluated.prod, evaluated.dev) };
        for (const mode of ["dev", "prod"] as const) {
          if (before[mode].status !== "ok" || renameEquivalenceSignature(before[mode], entityRemap, { reparent: moves.length > 0 }) !== renameEquivalenceSignature(checked.models[mode], {}, { reparent: moves.length > 0 })) {
            const entity = codeRename?.kind === "rename" ? codeRename.entity : moves[0]!.entity;
            renameIssues.push({ message: `The ${mode === "dev" ? "Development" : "Production"} rename would change behavior beyond the approved identity remap. Resolve the source before applying.`, source: state.snapshot.source.entities[entity]!.key });
          }
        }
      } finally { await pool.dispose(); }
    }
    // Preserve useful both-mode diagnostics when the generator rejected invalid
    // authored intent. A generator failure on otherwise valid intent still blocks
    // review; it can never silently omit required generated artifacts.
    if (generationFailure && !renameIssues.length && checked.preflight.dev.ok && checked.preflight.prod.ok) throw generationFailure.error;
    for (const [file, before] of handlerBefore) if (readFileSync(file, "utf8") !== before) throw new EditError(409, "The event handler changed during review. Your draft is preserved; review it again.");
    for (const mode of [checked.models.dev, checked.models.prod]) for (const ref of replayTargets) {
      if (!checked.preflight[mode.mode].ok) continue;
      const target = mode.targets.find((target) => target.ref === ref);
      if (!target || !handlerBefore.has(replayHandlerFile(this.root, target).file)) throw new EditError(422, "Local replay must keep the event's TypeScript handler entry point.");
    }
    this.unchanged(revision, hashes, triggerSources, generationInputs);
    assertStartersUnchanged(this.root, templates);
    if (namingFingerprint && namingSourceFingerprint(this.root) !== namingFingerprint) throw new EditError(409, "Source files or project configuration changed during rename review. Your draft is preserved; review again.");
    const comments = reviewedComments();
    let response: BatchPlanResponse = {
      ...(rename ? { rename } : {}), ...(renameIssues.length ? { renameIssues } : {}), ...(entityRemap ? { entityRemap } : {}),
      ...(comments.length ? { comments } : {}),
      planId: randomUUID(), summaries,
      changes: changes.map(({ file, before, after }) => ({ file: toRelative(this.root, file), operation: before === null ? "create" : after === null ? "delete" : "modify", diff: diffOf(toRelative(this.root, file), before ?? "", after ?? "") })),
      preflight: checked.preflight, ok: checked.preflight.dev.ok && checked.preflight.prod.ok && !renameIssues.length && !comments.some(comment => comment.manualReason),
      ...(creation ? { select: creation.expected.select } : {}),
      impact: creation ? creation.impact : edits.every((edit) => edit.kind === "clientEnvironment") ? ["Saves mapping definitions for the next environment export. Environment-file generation is separate."] : ["Applies this complete draft as one source change. Individual workload overrides remain in place when shared defaults change.",
        ...(edits.some(edit => edit.kind === "field" && edit.intent.field === "lambda.reservedConcurrentExecutions") ? ["Reserved concurrency changes the function's AWS invocation limit on the next deployment. A value of zero stops invocations; disabling it returns the function to the shared concurrency pool. Local execution is unchanged."] : []),
        ...(edits.some(edit => edit.kind === "field" && edit.intent.field === "lambda.provisionedConcurrentExecutions") ? ["Provisioned concurrency keeps execution environments ready and incurs AWS charges after deployment. The framework publishes a version and routes managed callers through a qualified alias while enabled. This review only saves source."] : []),
        ...(edits.some(edit => edit.kind === "deploy" && model.targets.some(target => target.ref === edit.target && target.role === "event")) ? ["Disabled event functions and their native AWS hooks, trigger descriptors and failure destinations are omitted on the next deployment. Cognito event changes can remove sign-up validation, custom messaging or post-confirmation behavior; this review only saves source."] : []),
        ...(replayTargets.length ? ["Updates localReplay and the handler's withLocalReplay wrapper together. The generated replay manifest is included in this review. Events that require local execution cannot turn replay off."] : []),
        ...edits.flatMap(edit => edit.kind === "deploy" && typeof edit.value !== "string" ? (["dev", "prod"] as const).map(mode => {
          const target = checked.models[mode].targets.find(target => target.ref === edit.target);
          const result = target?.lanes.when?.[mode];
          return `${edit.target}: ${mode === "dev" ? "Development" : "Production"} condition ${result === "holds" ? "matches" : result === "unset" ? "is unset" : "does not match"}; ${mode === "dev" ? target?.lanes.local || target?.lanes.dev ? "enabled" : "disabled" : target?.lanes.prod ? "enabled" : "disabled"}.`;
        }) : []),
        ...(edits.some(edit => edit.kind === "network") ? ["CIDR or availability-zone changes may replace subnets and attached infrastructure on deployment. NAT and interface endpoints incur hourly and data charges when built."] : []),
        ...(edits.some(edit => edit.kind === "privateZone") ? ["Saves private-zone declarations, VPC associations, A aliases and explicit HTTP/80 grants. AWS deployment is separate. Zone-name changes can replace the hosted zone; DNS creation incurs Route 53 charges when deployed. Local private DNS execution is unavailable until the scoped runtime is qualified; framework-mediated invocation paths refuse associated workloads. Independently running Compose services are not stopped or isolated."] : []),
        ...(edits.some(edit => edit.kind === "database") ? ["Changes PostgreSQL declaration defaults while preserving native construct identities. Multi-AZ, replicas, and Proxy add billed capacity. Review engine/storage changes and the production synth before a separate deployment; DATABASE_* inputs or CDK context may override these defaults."] : []),
        ...(edits.some(edit => edit.kind === "databasePlacement") ? ["Changes the database's declared home and coordinates framework workload VPC references. This saves source only: it does not copy data, relocate a running RDS instance, or change local PostgreSQL. Existing RDS requires a separately approved migration/cutover and review of both synths before deployment. Native CDK connections remain source-owned."] : []),
        ...(edits.some(edit => edit.kind === "removeNetwork") ? ["Removes an unused VPC declaration, its registry import, and descriptions. Existing AWS resources are unchanged until a separately reviewed deployment."] : []),
        ...(edits.some(edit => edit.kind === "placement") ? ["Moving a workload between VPCs updates its cloud networking. Local Compose networking remains shared."] : []),
        ...(routes.length ? ["Public route paths change; Lambda target and construct identities are preserved. Generated API contracts are included in this review; update callers before deployment."] : []),
        ...(triggerSources ? edits.filter((edit) => edit.kind === "triggers").flatMap((edit) => {
          const before = model.triggers?.filter((binding) => binding.event === edit.event) ?? [];
          return [
            ...before.filter((binding) => !edit.bindings.some((next) => JSON.stringify(next) === JSON.stringify(binding))).map((binding) => `Remove/update ${binding.resource || binding.adapter} → lambda:${edit.event} (${binding.id}).`),
            ...edit.bindings.filter((binding) => !before.some((old) => JSON.stringify(old) === JSON.stringify(binding))).flatMap((binding) => [
              `${binding.resource || binding.adapter} → lambda:${edit.event}: ${model.triggerAdapters?.find((item) => item.kind === binding.adapter)?.delivery ?? binding.adapter}. Handler contract acknowledged: ${binding.accepts}.`,
              ...[triggerTiming(state.snapshot, { ...binding, event: edit.event }).recommendation].filter((line): line is string => !!line),
              ...model.edges.filter((edge) => binding.adapter === "s3" && edge.relation === "grant" && edge.from === `lambda:${edit.event}` && edge.to === binding.resource && /grant(Read)?Write|grantPut/.test(edge.label)).map((edge) => `lambda:${edit.event} can write to this bucket (${edge.label}); its writes must not match this trigger's filter.`),
            ]),
          ];
        }) : []),
        ...edits.flatMap((edit) => edit.kind !== "onFailure" ? [] : [edit.value
          ? `Failed asynchronous runs of lambda:${edit.event} go to ${edit.value.destination} after ${edit.value.retryAttempts ?? 2} retries; the function is granted permission to send there. Queue and stream triggers keep their own failure handling.`
          : `Failed asynchronous runs of lambda:${edit.event} are dropped after Lambda's retries.`]),
        ...(native?.removed ?? []).flatMap((edge) => {
          const adapter = model.triggerAdapters?.find((item) => item.nativeSlots?.[edge.label] !== undefined || Object.values(item.nativeSlots ?? {}).includes(edge.label));
          const remaining = [...state.snapshot.source.cdkLinks.edges, ...model.edges.filter((item) => item.provenance === "declared")].filter((item) => item.relation === "trigger" && item.to === edge.to && !native!.removed.includes(item));
          return [
            `Removes native ${edge.label} (${edge.from} → ${edge.to}) from ${edge.source!.file}:${edge.source!.line}; it stops on the next deploy.`,
            ...(adapter?.kind === "cognito" && !["postConfirmation", "postAuthentication"].includes(edge.label) ? [`⚠ Cognito stops calling ${edge.label} synchronously: any sign-up, sign-in or message validation it performs no longer runs.`] : []),
            ...(remaining.length ? [] : [`${edge.to} keeps its declaration and will have no trigger.`]),
          ];
        }),
        "Compose Watch may restart local workloads after the source files are written. Deployment is a separate action."],
    };
    const replaySources = [...handlerBefore].map(([file, before]) => ({ file, before, after: overrides.get(file)! }));
    if (edits.some(edit => edit.kind === "identityPolicy")) (response.impact as string[]).push("ReaderRole IAM and explicit guest opt-in changes take effect only after a separate synth/diff/deployment review. Enabled guests can obtain a separate permissionless unauthenticated identity role; ReaderRole grants never attach to guests. Source statements and policy simulation do not prove group claims, trust, boundaries/SCPs, resource policies or runtime API authorization. The default authenticated role remains permissionless.");
    const addedDirectories = changes.filter(change => change.before === null).flatMap(change => { const folders: string[] = []; for (let folder = path.dirname(change.file); folder !== this.root && !existsSync(folder); folder = path.dirname(folder)) folders.push(folder); return folders; });
    let dependencyReview: ProjectInstallationReview | undefined;
    if (response.ok && !frameworkCandidate && changes.some(change => change.file === path.join(this.root, "package-lock.json"))) {
      dependencyReview = await prepareProjectDependencies(this.root, changes, async root => {
        const builder = new SnapshotBuilder(root, undefined, undefined, this.builder.conditionInputRoot);
        try {
          const candidate = new BatchEditor(root, builder, new Map());
          const installed = await candidate.validate({}, state, routes, undefined, creation?.expected,
            edits.flatMap(edit => edit.kind === "removeWorkload" ? [edit.target] : edit.kind === "removeGateway" ? [edit.gateway] : []));
          for (const mode of ["dev", "prod"] as const) {
            if (!installed.preflight[mode].ok || creationSignature(installed.models[mode]) !== creationSignature(checked.models[mode])) {
              throw new EditError(422, `The candidate dependency installation changed or failed the ${mode} model reviewed for this edit.`);
            }
          }
        } finally { await builder.dispose(); }
      });
      this.unchanged(revision, hashes, triggerSources, generationInputs);
      response = { ...response, activatesDependencies: true, impact: [
        ...response.impact,
        `Apply activates the reviewed workspace dependencies with the source and lockfile using project Node ${dependencyReview.runtime.version} and npm ${dependencyReview.runtime.npmVersion}.`,
      ] };
    }
    this.plans.set(response.planId, { checked, dependencyReview, namingSources: [...namingSources], namingFingerprint, namingHashes, entityRemap, ...(entityRemap ? { namingModels: { dev: creationSignature(checked.models.dev), prod: creationSignature(checked.models.prod) } } : {}), label: creation ? `Create ${creation.expected.select}` : `${edits.length} inspector changes`, response, revision, hashes, changes, edits, routes, replayTargets, replaySources, triggerSources, commentOptions: { comments: Object.fromEntries(comments.map(comment => [comment.id, comment.resolution])) }, generatedFiles: [...generatedFiles], generationInputs, ...(addedDirectories.length ? { createdDirectories: [...new Set(addedDirectories)] } : {}), implementationFiles: [...implementationFiles], templates, ...(edits.some(edit => edit.kind === "iamPolicy" || edit.kind === "deploy" || edit.kind === "connection" || edit.kind === "removeWorkload" || ["agentGateways", "gatewayTools", "gatewayDeploy", "removeGateway", "privateZone"].includes(edit.kind)) ? { operationModels: { dev: creationSignature(checked.models.dev), prod: creationSignature(checked.models.prod) } } : {}), ...(deletions.size ? { networkRemovals: [...deletions.keys()], createdDirectories: [...new Set([...addedDirectories, ...[...deletions.keys()].map(file => path.dirname(file))])] } : {}), ...((native || policyFiles.size) ? { cdkSources: [...new Set([...(native?.changes.keys() ?? []), ...policyFiles])] } : {}), ...(creation ? { creation: creation.expected, creationModels: { dev: creationSignature(checked.models.dev), prod: creationSignature(checked.models.prod) }, createdDirectories: [...new Set(changes.filter((change) => change.before === null).flatMap((change) => {
      const directories: string[] = [];
      for (let directory = path.dirname(change.file); directory !== this.root && !existsSync(directory); directory = path.dirname(directory)) directories.push(directory);
      return directories;
    }))] } : {}) });
    return response;
  }
  private async validate(overrides: Record<string, string>, state: StudioState, routes: readonly RouteChange[], expectedNative?: readonly string[], creation?: CreationExpectation, removedTargets: readonly string[] = [], deletedFiles: readonly string[] = [], naming = false) {
    const descriptions = overrides[path.join(this.root, DESCRIPTION_FILE)];
    if (descriptions !== undefined) parseDescriptions(descriptions);
    const names = overrides[path.join(this.root, DISPLAY_NAMES_FILE)];
    if (names !== undefined) parseDisplayNames(names);
    const clientMappings = overrides[path.join(this.root, CLIENT_ENVIRONMENT_FILE)];
    if (clientMappings !== undefined) {
      try { parseClientMappings(clientMappings); }
      catch (error) { throw new EditError(422, error instanceof Error ? error.message : String(error)); }
    }
    const pool = new EvaluatorPool(this.root, undefined, this.builder.evaluators, undefined, this.builder.conditionInputRoot);
    try {
      const evaluated = await pool.evaluate(overrides);
      // Review uses the same cross-mode metadata projection as the visible
      // snapshot, including a production-only database's inherited stack tags.
      const models = { dev: withAbsentTagging(evaluated.dev, evaluated.prod), prod: withAbsentTagging(evaluated.prod, evaluated.dev) };
      if (clientMappings !== undefined) validateClientMappings(parseClientMappings(clientMappings).mappings, Object.values(models));
      const triggerChange = [models.dev, models.prod].some((model: ModeModel) => JSON.stringify([model.triggers, model.failureDestinations]) !== JSON.stringify([state.snapshot.models[model.mode].triggers, state.snapshot.models[model.mode].failureDestinations]));
      const stackChange = Object.keys(overrides).some((file) => toRelative(this.root, file).startsWith("cdk-app/lib/"));
      const databasePlacementChanged = [models.dev, models.prod].some(model => model.managedDatabase?.networkId !== state.snapshot.models[model.mode].managedDatabase?.networkId || model.managedDatabase?.subnet !== state.snapshot.models[model.mode].managedDatabase?.subnet);
      const implementationChanged = Object.keys(overrides).some(file => /^compute\//.test(toRelative(this.root, file)));
      const connectionsChanged = [models.dev, models.prod].some(model => connectionSignature(model) !== connectionSignature(state.snapshot.models[model.mode]));
      const typeErrors = triggerChange || stackChange || databasePlacementChanged || implementationChanged || connectionsChanged || creation || naming ? resourceTypeErrors(this.root, overrides, new Set(deletedFiles)) : [];
      const native = stackChange ? nativeSignature(scanWith(this.root, state, overrides)) : undefined;
      const unexpected = expectedNative && native ? [...native.filter((item) => !expectedNative.includes(item)).map((item) => `adds ${item}`), ...expectedNative.filter((item) => !native.includes(item)).map((item) => `removes ${item}`)] : [];
      const nativeMismatch = expectedNative && (JSON.stringify(native) !== JSON.stringify(expectedNative));
      const verdict = (model: ModeModel) => {
        const diagnostics = [...model.diagnostics];
        for (const target of model.targets) {
          const prior = state.snapshot.models[model.mode].targets.find(item => item.ref === target.ref);
          const changed = JSON.stringify(target.compute) !== JSON.stringify(prior?.compute) || !prior;
          for (const message of target.implementation?.problems ?? []) if (changed || !prior?.implementation?.problems.includes(message)) diagnostics.push({ severity: "error", stage: "validate", entity: target.ref, message });
        }
        for (const message of typeErrors) diagnostics.push({ severity: "error", stage: "validate", message });
        if (nativeMismatch) diagnostics.push({ severity: "error", stage: "validate", message: `Removing this wiring would also change other native wiring (${unexpected.slice(0, 3).join("; ").replaceAll("|", " ") || "order"}). Edit it in source.` });
        for (const binding of model.triggers ?? []) {
          try { validateTriggerBindings(state.snapshot, binding.event, [binding]); }
          catch (error) { diagnostics.push({ severity: "error", stage: "validate", message: error instanceof Error ? error.message : String(error) }); }
        }
        const stableIdentity = (value: ModeModel) => identity({ ...value, targets: value.targets.filter(target => !removedTargets.includes(target.ref)), gateways: value.gateways?.filter(gateway => !removedTargets.includes(gateway.id)) });
        if (!creation && stableIdentity(model) !== stableIdentity(state.snapshot.models[model.mode])) diagnostics.push({ severity: "error", stage: "validate", message: "An inspector edit must preserve workload target and construct identities." });
        if (creation) {
          const present = new Set([...model.targets.map((target) => target.ref), ...model.resources.map((resource) => resource.id), ...model.routes.map((route) => route.id), ...(model.gateways ?? []).map(gateway => gateway.id)]);
          for (const id of [...creation.targets, ...creation.resources, ...creation.routes, ...(creation.gateways ?? [])]) if (!present.has(id)) diagnostics.push({ severity: "error", stage: "validate", message: `Creation must register ${id} in the ${model.mode} model.` });
          if (creation.httpHead && !model.routes.some(route => route.id === creation.httpHead!.route
            && route.target === creation.httpHead!.target && Array.isArray(route.methods) && route.methods.includes("GET") && route.methods.includes("HEAD"))) {
            diagnostics.push({ severity: "error", stage: "validate", message: "The proposed HTTP route must register GET and HEAD on the same Lambda." });
          }
          if (creation.network && Object.entries(creation.network).some(([key, value]) => JSON.stringify(model.networks?.find(network => network.id === creation.network!.id)?.[key as keyof NonNullable<ModeModel["networks"]>[number]]) !== JSON.stringify(value))) diagnostics.push({ severity: "error", stage: "validate", message: "The proposed network declaration does not contain the expected VPC." });
          const previous = state.snapshot.models[model.mode];
          const allowed = new Set(creation.targets);
          for (const target of previous.targets) if (!allowed.has(target.ref) && !model.targets.some((item) => item.ref === target.ref && item.constructId === target.constructId)) diagnostics.push({ severity: "error", stage: "validate", message: "Creation must preserve existing workload identities." });
        }
        for (const route of routes) if (!model.routes.some((item) => item.kind === "http" && item.path === route.after && item.target === route.target)) diagnostics.push({ severity: "error", stage: "validate", message: `Route ${route.after} must still reach ${route.target}.` });
        return { mode: model.mode, ok: !diagnostics.some((item) => item.severity === "error"), diagnostics };
      };
      return { models, native, preflight: { dev: verdict(models.dev), prod: verdict(models.prod) } };
    } finally { await pool.dispose(); }
  }
  async apply(planId: string): Promise<ApplyResponse> {
    const reviewed = this.plans.get(planId);
    if (!reviewed) throw new EditError(410, "This review expired. Your draft is preserved; review it again.");
    if (!reviewed.response.ok) throw new EditError(422, "Fix the rejected settings before applying this draft.");
    // Reject known stale proposals before reserving a new publication epoch.
    // The owned path repeats these checks to cover a competing writer.
    this.unchanged(reviewed.revision, reviewed.hashes, reviewed.triggerSources, reviewed.generationInputs, reviewed.namingHashes);
    this.namingUnchanged(reviewed);
    for (const change of reviewed.changes) if (sourceContents(change.file) !== change.before) throw new EditError(409, `${toRelative(this.root, change.file)} changed after review.`);
    this.checkRemovalConsumers(reviewed, this.state());
    const dependencyReview = reviewed.upgrade ?? reviewed.dependencyReview;
    if (dependencyReview) {
      return withReviewedProjectInstallation(this.root, dependencyReview, reviewed.changes,
        candidate => withSourceWrite(this.root, () => this.applyOwned(planId, candidate)));
    }
    return withSourceWrite(this.root, () => this.applyOwned(planId));
  }
  /** Internal handoff to common immutable review; never reconstruct bytes from a browser diff. */
  exportReviewedSource(planId: string): ReviewedStructuredSource {
    const plan = this.plans.get(planId);
    if (!plan) throw new EditError(410, "This review expired. Review current source again.");
    if (!plan.response.ok) throw new EditError(422, "Fix rejected settings before creating a source proposal.");
    if (plan.upgrade || plan.dependencyReview) throw new EditError(422, "Apply dependency changes through Review Changes before creating a structured proposal.");
    this.unchanged(plan.revision, plan.hashes, plan.triggerSources, plan.generationInputs, plan.namingHashes);
    this.namingUnchanged(plan);
    for (const change of plan.changes) if (sourceContents(change.file) !== change.before) throw new EditError(409, `${toRelative(this.root, change.file)} changed after review.`);
    return { planId, revision: plan.revision, changes: plan.changes.map(change => ({ path: toRelative(this.root, change.file), before: change.before, after: change.after })), preflight: structuredClone(plan.response.preflight), select: plan.response.select, entityRemap: plan.entityRemap ? { ...plan.entityRemap } : undefined };
  }
  private async applyOwned(planId: string, candidate?: string): Promise<ApplyResponse> {
    const plan = this.plans.get(planId);
    if (!plan) throw new EditError(410, "This review expired. Your draft is preserved; review it again.");
    if (!plan.response.ok) throw new EditError(422, "Fix the rejected settings before applying this draft.");
    this.unchanged(plan.revision, plan.hashes, plan.triggerSources, plan.generationInputs, plan.namingHashes);
    this.namingUnchanged(plan);
    return this.write(plan, candidate);
  }
  private namingUnchanged(entry: BatchChanges): void {
    // Upgrade starters can read package-lock.json from the staged release.
    // The installation review binds the entire live source baseline instead.
    if (!entry.upgrade) assertStartersUnchanged(this.root, entry.templates);
    if (entry.namingFingerprint && namingSourceFingerprint(this.root) !== entry.namingFingerprint) throw new EditError(409, "Source files or project configuration changed since rename review. Your draft is preserved; review again.");
  }
  private checkRemovalConsumers(entry: BatchChanges, state: StudioState): void {
    withCommentReview(this.root, entry.commentOptions, () => {
      for (const edit of entry.edits) if (edit.kind === "removeNetwork") planNetworkRemoval(this.root, state, edit.network, new SourceFiles());
      for (const edit of entry.edits) if (edit.kind === "removeWorkload") planWorkloadRemoval(this.root, state, edit.target, new Map());
      for (const edit of entry.edits) if (edit.kind === "removeGateway") planGatewayOperation(this.root, state, edit, new Map());
    });
  }
  private async write(entry: BatchChanges, candidate?: string): Promise<ApplyResponse> {
    const dependencyReview = entry.upgrade ?? entry.dependencyReview;
    if (dependencyReview && !candidate) throw new EditError(409, "The reviewed candidate installation is unavailable. Review the change again.");
    if (dependencyReview) assertCurrentProjectInstallation(this.root, dependencyReview);
    const upgradeFiles = new Set(entry.upgrade?.changes.map(change => change.file));
    this.namingUnchanged(entry);
    const state = this.state();
    const hashes = hashEditableFiles(this.root);
    const unchangedInputs = Object.fromEntries(Object.entries(entry.generationInputs ?? {}).filter(([file]) => !entry.changes.some(change => toRelative(this.root, change.file) === file)));
    const triggerSources = { ...(entry.triggerSources && !entry.creation ? state.snapshot.source.capabilityFiles : {}), ...unchangedInputs };
    this.unchanged(state.snapshot.revision, hashes, triggerSources, entry.namingHashes);
    this.namingUnchanged(entry);
    const changes = entry.changes;
    const handlers = entry.replayTargets.map((ref) => state.snapshot.models.dev.targets.find((target) => target.ref === ref)).map((target) => target && replayHandlerFile(this.root, target).file);
    for (const source of entry.replaySources) {
      if (!handlers.includes(source.file) || readFileSync(source.file, "utf8") !== source.before) throw new EditError(409, "The event handler changed since review. No files were written.");
    }
    assertOwnershipAllows(this.root, state, changes);
    for (const change of changes) {
      if (upgradeFiles.has(change.file)) projectUpgradeFile(this.root, toRelative(this.root, change.file));
      else if ((entry.cdkSources ?? []).includes(change.file)) assertStackFile(this.root, state, toRelative(this.root, change.file));
      else if (entry.namingSources?.includes(change.file)) assertResourceFile(this.root, change.file);
      else if (change.file === path.join(this.root, DISPLAY_NAMES_FILE)) assertCreationFile(this.root, DISPLAY_NAMES_FILE);
      else if (entry.creation || entry.networkRemovals?.includes(change.file) || entry.generatedFiles?.includes(change.file) || entry.implementationFiles?.includes(change.file)) assertCreationFile(this.root, toRelative(this.root, change.file));
      else if (!handlers.includes(change.file)) assertWritable(this.root, toRelative(this.root, change.file));
      if (sourceContents(change.file) !== change.before) throw new EditError(409, `${toRelative(this.root, change.file)} changed. Your draft is preserved; no files were written.`);
    }
    const checkNetworkConsumers = () => this.checkRemovalConsumers(entry, state);
    checkNetworkConsumers();
    const routes = entry.routes;
    const checked = dependencyReview && entry.checked ? entry.checked : await this.validate(Object.fromEntries(changes.filter((change) => change.after !== null).map((change) => [change.file, change.after!])), state, routes, undefined, entry.creation, entry.edits.flatMap(edit => edit.kind === "removeWorkload" ? [edit.target] : edit.kind === "removeGateway" ? [edit.gateway] : []), changes.filter(change => change.after === null).map(change => change.file), !!entry.entityRemap || entry.edits.some(edit => edit.kind === "resourceConfig" || edit.kind === "iamPolicy"));
    if (!checked.preflight.dev.ok || !checked.preflight.prod.ok) throw new EditError(422, "The complete draft no longer validates. Review the current configuration before trying again.");
    if (entry.namingModels) for (const mode of ["dev", "prod"] as const) if (creationSignature(checked.models[mode]) !== entry.namingModels[mode]) throw new EditError(409, "The reviewed naming semantics changed. Review current source before applying.");
    if (entry.creationModels) for (const mode of ["dev", "prod"] as const) {
      if (creationSignature(checked.models[mode]) !== entry.creationModels[mode]) throw new EditError(409, "The creation's framework semantics changed since review. Review the current source before applying.");
    }
    if (entry.operationModels) for (const mode of ["dev", "prod"] as const) if (creationSignature(checked.models[mode]) !== entry.operationModels[mode]) throw new EditError(409, "The reviewed connection/removal semantics changed. Review current source before applying.");
    this.unchanged(state.snapshot.revision, hashes, triggerSources, entry.namingHashes);
    this.namingUnchanged(entry);
    checkNetworkConsumers();
    for (const source of entry.replaySources) if (readFileSync(source.file, "utf8") !== source.before) throw new EditError(409, "The event handler changed while validating. No files were written.");
    if (dependencyReview) assertCurrentProjectInstallation(this.root, dependencyReview);
    const written: Change[] = [];
    const installation = dependencyReview && candidate ? stageInstallation(this.root, candidate, dependencyReview) : undefined;
    let journalId: string;
    try {
      journalId = this.journal.begin(entry.label, changes.map(change => upgradeFiles.has(change.file) ? { ...change, authority: "project-upgrade" as const } : (entry.cdkSources ?? []).includes(change.file) ? { ...change, authority: "native" as const } : entry.namingSources?.includes(change.file) ? { ...change, authority: "resource" as const } : change), undefined, entry.templates, installation);
    } catch (error) {
      if (installation) finishInstallation(this.root, installation, "restored");
      throw error;
    }
    let activating = false;
    try {
      if (dependencyReview) {
        await assertCurrentProjectDependencies(this.root, dependencyReview);
        assertCurrentProjectInstallation(this.root, dependencyReview);
        await this.builder.pool.dispose();
      }
      for (const change of changes) {
        if (!upgradeFiles.has(change.file) && (entry.creation || entry.networkRemovals?.includes(change.file) || entry.generatedFiles?.includes(change.file) || entry.implementationFiles?.includes(change.file))) assertCreationFile(this.root, toRelative(this.root, change.file));
        if (sourceContents(change.file) !== change.before) throw new Error("A source file changed while applying the draft.");
        this.writeFile(this.root, change.file, change.before, change.after);
        written.push(change);
        this.ownWrites.set(toRelative(this.root, change.file), change.after === null ? "absent" : sha256(change.after));
      }
      if (installation) {
        activating = true;
        activateInstallation(this.root, installation);
      }
      cleanupCreatedDirectories(entry);
      const actual = await this.builder.refresh();
      if (dependencyReview) await assertActivatedProjectInstallation(this.root, dependencyReview);
      for (const edit of entry.edits) if (edit.kind === "resourceConfig") {
        for (const mode of ["dev", "prod"] as const) {
          const resource = actual.snapshot.models[mode].resources.find(resource => resource.id === (entry.entityRemap?.[edit.intent.resource] ?? edit.intent.resource));
          if (edit.intent.resource.startsWith("framework:") && (!resource?.inputChoices || !sameInputModes(inputModeIntents(resource), edit.intent.modes))) throw new Error("The saved framework input behavior did not match the review.");
          if (edit.intent.choices !== undefined && resource && (!resource.absent || resource.inputChoices) && JSON.stringify(resource.values ?? []) !== JSON.stringify(edit.intent.choices.map(value => value.trim()))) throw new Error("The saved input choices did not match the review.");
        }
      }
      const mappingChange = changes.find((change) => change.file === path.join(this.root, CLIENT_ENVIRONMENT_FILE));
      if (mappingChange) {
        const file = actual.snapshot.models.dev.resources.find((resource) => resource.clientEnvironment)?.clientEnvironment;
        if (file?.problem || JSON.stringify(file?.mappings) !== JSON.stringify(parseClientMappings(mappingChange.after!).mappings)) throw new Error("Client mappings did not match the review.");
      }
      const nameChange = changes.find(change => change.file === path.join(this.root, DISPLAY_NAMES_FILE));
      if (nameChange && (actual.snapshot.displayNames?.problem || JSON.stringify(actual.snapshot.displayNames?.values) !== JSON.stringify(parseDisplayNames(nameChange.after!).values))) throw new Error("The display names did not match the review.");
      const descriptionChange = changes.find((change) => change.file === path.join(this.root, DESCRIPTION_FILE));
      if (descriptionChange && (descriptionChange.after === null
        ? sourceContents(descriptionChange.file) !== null
        : actual.snapshot.descriptions.problem || JSON.stringify(actual.snapshot.descriptions.values) !== JSON.stringify(parseDescriptions(descriptionChange.after).values))) throw new Error("The descriptions did not match the review.");
      for (const mode of ["dev", "prod"] as const) {
        if (entry.edits.some(edit => edit.kind === "privateZone") && JSON.stringify(actual.snapshot.models[mode].privateHostedZones) !== JSON.stringify(checked.models[mode].privateHostedZones)) throw new Error("Private DNS declarations did not match the reviewed configuration.");
        const model = actual.snapshot.models[mode];
        const expected = checked.models[mode];
        if ((entry.namingModels || entry.edits.some(edit => edit.kind === "resourceConfig" || edit.kind === "iamPolicy")) && creationSignature(model) !== creationSignature(expected)) throw new Error(`The ${mode} naming and input relationships did not match the review.`);
        if (model.stale || model.status === "error" || identity(model) !== identity(expected)) throw new Error(`The ${mode} configuration did not match the review.`);
        if (JSON.stringify(model.triggers) !== JSON.stringify(expected.triggers)) throw new Error("Trigger connections did not match the review.");
        if (JSON.stringify(model.failureDestinations) !== JSON.stringify(expected.failureDestinations)) throw new Error("Failure destinations did not match the review.");
        if (checked.native && JSON.stringify(nativeSignature(actual.snapshot.source.cdkLinks)) !== JSON.stringify(checked.native)) throw new Error("Native triggers did not match the review.");
        if (entry.edits.some(edit => edit.kind === "tags") && tagSignature(model) !== tagSignature(expected)) throw new Error(`Declaration tags did not match the review (${mode}: ${tagDifferences(model, expected)}).`);
        for (const edit of entry.edits) {
          if ((edit.kind === "database" || edit.kind === "databasePlacement") && JSON.stringify(model.managedDatabase) !== JSON.stringify(expected.managedDatabase)) throw new Error("Database declaration did not match the review.");
          if (edit.kind === "databasePlacement") for (const consumer of databaseConsumers([expected], edit.database)) {
            const placement = (value: ModeModel) => value.targets.find(target => target.ref === consumer.target)?.placement;
            if (JSON.stringify(placement(model)) !== JSON.stringify(placement(expected))) throw new Error(`The database placement of ${consumer.target} did not match the review.`);
          }
          if (edit.kind === "removeNetwork" && JSON.stringify(model.networks?.find(network => network.id === edit.network)) !== JSON.stringify(expected.networks?.find(network => network.id === edit.network))) throw new Error("The VPC registry did not match the removal review.");
          if (edit.kind === "placement") {
            const placement = (value: ModeModel) => value.targets.find(target => target.ref === edit.target)?.placement;
            if (JSON.stringify(placement(model)) !== JSON.stringify(placement(expected))) throw new Error(`The placement of ${edit.target} did not match the review.`);
          }
          if (edit.kind === "network") {
            const settings = (value: ModeModel) => value.networks?.filter(network => network.id === edit.network).map(({ builtInProd, ...network }) => network);
            if (JSON.stringify(settings(model)) !== JSON.stringify(settings(expected))) throw new Error(`VPC ${edit.network} did not match the review.`);
          }
          if (edit.kind !== "field") continue;
          const field = (model: ModeModel) => model.fields[edit.intent.target]?.find((fact) => fact.field === edit.intent.field);
          if (JSON.stringify([field(model)?.authored, field(model)?.effective]) !== JSON.stringify([field(expected)?.authored, field(expected)?.effective])) throw new Error(`The setting ${edit.intent.field} did not match the review.`);
        }
        for (const route of routes) if (!model.routes.some((item) => item.path === route.after && item.target === route.target)) throw new Error("A route did not match the review.");
      }
      if (entry.creation) {
        for (const mode of ["dev", "prod"] as const) {
          if (creationSignature(actual.snapshot.models[mode]) !== creationSignature(checked.models[mode])) throw new Error(`The ${mode} resource relationships did not match the creation review.`);
        }
        if (entry.creation.kind === "stack") {
          const resource = actual.snapshot.models.dev.resources.find((resource) => resource.id === entry.creation!.select);
          if (resource?.stackUsage?.status !== "referenced") throw new Error("The new stack was not registered in the CDK application.");
          if (!actual.snapshot.models.dev.resources.some((item) => ["queue", "bucket", "identityPool"].some(member => item.id === `${entry.creation!.select}.${member}`) && item.parent === entry.creation!.select && item.kind === "member")) throw new Error("The stack's typed public resource was not exposed in the resource catalog.");
        }
      }
      const entityRemap = entry.entityRemap ? namingEntityRemap(state.snapshot, actual.snapshot, entry.entityRemap) : undefined;
      this.journal.finish(journalId, "complete");
      this.expirePlans();
      const removed = entry.edits.find(edit => edit.kind === "removeNetwork");
      const selection = entry.creation ? entry.creation.select : removed?.kind === "removeNetwork" ? actual.snapshot.models.prod.networks?.[0] ? `island:vpc:${actual.snapshot.models.prod.networks[0].id}` : "island:lambda" : undefined;
      return { ...(entityRemap ? { entityRemap } : {}), status: "applied", message: `Applied all ${entry.edits.length} changes.${entry.upgrade ? ` The project now uses framework ${entry.upgrade.version} and its reviewed dependencies.` : dependencyReview ? " The reviewed workspace dependencies are installed." : ""}`, revision: actual.snapshot.revision, ...(selection ? { select: selection } : {}) };
    } catch (error) {
      let conflicted = activating && !!installation && !restoreInstallation(this.root, installation);
      for (const change of written.reverse()) {
        if (upgradeFiles.has(change.file)) { try { projectUpgradeFile(this.root, toRelative(this.root, change.file)); } catch { conflicted = true; continue; } }
        else if (entry.creation || entry.generatedFiles?.includes(change.file) || entry.implementationFiles?.includes(change.file)) { try { assertCreationFile(this.root, toRelative(this.root, change.file)); } catch { conflicted = true; continue; } }
        if (sourceContents(change.file) !== change.after) { conflicted = true; continue; }
        try {
          this.writeFile(this.root, change.file, change.after, change.before, { restoring: true });
          this.ownWrites.set(toRelative(this.root, change.file), change.before === null ? "absent" : sha256(change.before));
        } catch { conflicted = true; }
      }
      cleanupCreatedDirectories(entry);
      this.journal.finish(journalId, conflicted ? "conflicted" : "restored");
      const actual = await this.builder.refresh().catch(() => undefined); this.expirePlans();
      return { status: conflicted ? "unconfirmed" : "reverted", message: `${error instanceof Error ? error.message : "The draft could not be applied."} ${conflicted ? "Concurrent edits were preserved; inspect the affected files." : installation ? "The previous source and dependency installation were restored." : "The source was restored."} Your draft is preserved.${actual ? "" : " The snapshot could not be refreshed; refresh Studio after resolving the failure."}`, revision: actual?.snapshot.revision ?? state.snapshot.revision };
    }
  }
}
