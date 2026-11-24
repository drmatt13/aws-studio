import assert from "./support/assert";
import { test } from "node:test";
import { deploymentFindings, nextAction, type FindingsInput } from "../shared/deploy-findings";
import type { DiscoveredDeploymentView, JobView, LocalRunView, StackView } from "../shared/deploy";

/**
 * What Deploy & Run says and offers for a deployment, from the three states it
 * reconciles: the repository's intent, what AWS holds, and this machine.
 */

const context = { profile: "dev", account: "222233334444", region: "us-east-1", arn: "arn:aws:sts::222233334444:assumed-role/Dev/me" };
const stack = (name: string, status = "UPDATE_COMPLETE", health: StackView["health"] = "complete"): StackView => ({ name, status, health, evidence: "tags", identity: { deployment: "my-aws-app", mode: "dev", contract: 2 } });

function deployed(overrides: Partial<DiscoveredDeploymentView> = {}): DiscoveredDeploymentView {
  const stacks = [stack("my-aws-app-CognitoStack"), stack("my-aws-app-DevLambdaReplayStack")];
  return { name: "my-aws-app", mode: "dev", account: context.account, region: context.region, contracts: [2], state: { kind: "ready", stacks }, stacks, ...overrides };
}

function local(overrides: Partial<LocalRunView> = {}): LocalRunView {
  return {
    project: "aws-studio-new",
    docker: { engine: "running", desktop: true },
    services: [], watch: { running: false }, client: { running: false },
    exported: { client: false }, startedBy: "none", restartNeeded: [],
    ...overrides,
  };
}

function input(overrides: Partial<FindingsInput> = {}): FindingsInput {
  return {
    name: "my-aws-app",
    target: { name: "my-aws-app", mode: "dev", origin: "implicit" },
    context, profileKind: "sso",
    local: local(), jobs: [],
    ...overrides,
    plans: (overrides.plans ?? []).map((plan) => ({ account: context.account, region: context.region, ...plan })),
  };
}

const codes = (value: FindingsInput) => deploymentFindings(value).map((finding) => finding.code);

test("an expired session is the one thing to fix, and Sign in is offered", () => {
  const value = input({ problem: { kind: "expired", message: "The selected profile's session has expired." } });
  assert.deepEqual(codes(value), ["SIGNED_OUT"]);
  assert.deepEqual(nextAction(deploymentFindings(value))?.id, "sign-in");
  const keys = input({ problem: { kind: "expired", message: "expired" }, profileKind: "static" });
  assert.equal(nextAction(deploymentFindings(keys))?.id, "refresh", "static keys do not sign in through a browser");
});

test("both development and production prepare explicit reviews", () => {
  assert.deepEqual(nextAction(deploymentFindings(input()))?.label, "Compare AWS templates");
  const production = input({ name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account } });
  const action = nextAction(deploymentFindings(production));
  assert.deepEqual([action?.id, action?.label], ["plan", "Compare AWS templates"]);
});

test("a fresh checkout starts against its existing deployment without a settings warning", () => {
  const value = input({ deployment: deployed(), detail: { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } } });
  const findings = deploymentFindings(value);
  assert.deepEqual(codes(value), ["DEPLOYED", "CLIENT_ENVIRONMENT", "READY_TO_START"]);
  assert.ok(findings.every(finding => finding.severity === "info"));
  assert.equal(nextAction(findings)?.id, "start");
  const client = findings.find(finding => finding.code === "CLIENT_ENVIRONMENT")!;
  assert.match(client.detail ?? "", /client-app\/\.env\.development\.local/);
  assert.match(client.detail ?? "", /framework-config\/client-environment\.ts/);
  assert.match(client.detail ?? "", /my-aws-app's CloudFormation outputs/);
  assert.deepEqual(client.actions, [{ id: "export", label: "Generate .env file", tone: "quiet" }]);
  const start = findings.find(finding => finding.code === "READY_TO_START")!;
  assert.match(start.detail ?? "", /automatically regenerates.*before starting Docker Compose/);
  assert.deepEqual(start.actions.map(action => action.id), ["start"], "manual generation belongs to its own card");
});

test("stopped runtime refreshes missing, stale and other-deployment exports as part of starting", () => {
  for (const exported of [{ client: false }, { deployment: "my-aws-app", client: false }, { deployment: "my-aws-app", client: true }, { deployment: "old-dev", client: true }]) {
    const value = input({ deployment: deployed(), local: local({ exported }),
      detail: { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { ...exported, fresh: false } } } });
    assert.deepEqual(codes(value), ["DEPLOYED", "CLIENT_ENVIRONMENT", "READY_TO_START"]);
    assert.equal(nextAction(deploymentFindings(value))?.id, "start");
  }
});

test("client environment generation describes the selected target's inputs", () => {
  const value = input({ deployment: deployed(), target: { name: "my-aws-app", mode: "dev", origin: "declared", inputs: "config/dev.inputs" } });
  assert.match(deploymentFindings(value).find(finding => finding.code === "CLIENT_ENVIRONMENT")?.detail ?? "", /config\/dev\.inputs/);
});

test("active runtime still reports mismatched settings and requires stopping before recovery", () => {
  const value = input({ deployment: deployed(), local: local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, watch: { running: true }, client: { running: true } }),
    detail: { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", client: true, fresh: false } } } });
  const stale = deploymentFindings(value).find(finding => finding.code === "EXPORT_STALE");
  assert.equal(stale?.severity, "attention");
  assert.equal(stale?.title, "Local settings do not match the deployment");
  assert.match(stale?.detail ?? "", /Stop local runtime/);
  assert.ok(stale?.actions.some(action => action.id === "export"));
  assert.equal(codes(value).includes("READY_TO_START"), false);
  const missing = deploymentFindings({ ...value, local: { ...value.local, exported: { client: false } } }).find(finding => finding.code === "EXPORT_OTHER");
  assert.equal(missing?.severity, "attention");
  assert.deepEqual(missing?.actions.map(action => action.id), ["stop"]);
});

test("with current settings, Docker is started before development is", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const stopped = input({ deployment: deployed(), detail: ready, local: local({ docker: { engine: "stopped", desktop: true }, exported: { deployment: "my-aws-app", client: true } }) });
  assert.equal(nextAction(deploymentFindings(stopped))?.id, "start-docker");
  assert.equal(deploymentFindings(stopped).find(finding => finding.code === "READY_TO_START")?.title, "Local development is stopped");
  const running = input({ deployment: deployed(), detail: ready, local: local({ exported: { deployment: "my-aws-app", client: true } }) });
  assert.deepEqual([nextAction(deploymentFindings(running))?.id, nextAction(deploymentFindings(running))?.label], ["start", "Start development"]);
});

test("a running stack started before the latest export asks for its changes to be applied, then for the watch", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const stale = input({ deployment: deployed(), detail: ready, local: local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, restartNeeded: ["api-dev-server"], watch: { running: true }, client: { running: true } }) });
  assert.equal(nextAction(deploymentFindings(stale))?.id, "apply-changes");
  const detached = input({ deployment: deployed(), detail: ready, local: local({ startedBy: "outside", exported: { deployment: "my-aws-app", client: true } }) });
  assert.ok(codes(detached).includes("WATCH_DETACHED"));
  assert.equal(nextAction(deploymentFindings(detached))?.id, "resume-watch");
});

test("a reviewed plan waiting to be applied comes first", () => {
  const value = input({ deployment: deployed(), plans: [{ key: "my-aws-app-abc123", deployment: "my-aws-app", mode: "dev", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false }] });
  const action = nextAction(deploymentFindings(value));
  assert.deepEqual([action?.id, action?.plan], ["review-plan", "my-aws-app-abc123"]);
});

test("stacks owned by another mode or nobody are a conflict, never something to deploy over", () => {
  const conflict = deployed({ state: { kind: "conflict", reason: "mode", stacks: [], message: "my-aws-app is a prod deployment in 222233334444/us-east-1, not dev." } });
  const findings = deploymentFindings(input({ deployment: conflict }));
  assert.equal(findings[0]?.severity, "blocking");
  assert.match(findings[0]?.detail ?? "", /prod deployment/);
  assert.equal(findings.flatMap((finding) => finding.actions).some((action) => action.id === "deploy" || action.id === "plan"), false);
});

test("first-create identity is pending only during the matching saved-plan apply", () => {
  const creating: StackView = { name: "my-aws-app-WebSocketLambdaFunctionsStack", status: "CREATE_IN_PROGRESS", health: "in-progress", evidence: "none" };
  const stacks = [stack("my-aws-app-CognitoStack"), creating];
  const conflict = deployed({ stacks, state: { kind: "conflict", reason: "unmarked", stacks, message: "The new stack has no deployment identity yet." } });
  const value = input({ profile: "dev", deployment: conflict,
    plans: [{ key: "my-aws-app-new", deployment: "my-aws-app", mode: "dev", profile: "dev", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false, creatingStacks: [creating.name] }],
    jobs: [{ id: "j1", kind: "deploy-apply", title: "Deploy my-aws-app", deployment: "my-aws-app", planId: "my-aws-app-new", params: { profile: "dev" }, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 1 }],
  });
  assert.deepEqual(codes(value), ["OPERATION_RUNNING", "DEPLOYMENT_IDENTITY_PENDING"]);
  assert.equal(deploymentFindings(value)[1]?.severity, "info");
  assert.deepEqual(deploymentFindings(value).flatMap(finding => finding.actions), [], "pending observation grants no action or ownership");
  assert.ok(codes({ ...value, jobs: [] }).includes("CONFLICT"), "terminal apply reveals any still-unmarked stack");
  assert.ok(codes({ ...value, jobs: value.jobs.map(job => ({ ...job, status: "succeeded" })) }).includes("CONFLICT"));
  assert.ok(codes({ ...value, jobs: value.jobs.map(job => ({ ...job, kind: "deploy-plan" })) }).includes("CONFLICT"), "synthesis is not a first create");
  for (const mismatch of [{ profile: "prod" }, { account: "111122223333" }, { region: "us-west-2" }, { mode: "prod" as const }, { creatingStacks: ["my-aws-app-UnrelatedStack"] }, { creatingStacks: undefined }]) {
    assert.ok(codes({ ...value, plans: value.plans.map(plan => ({ ...plan, ...mismatch })) }).includes("CONFLICT"), "different or missing saved review evidence remains a conflict");
  }
  const completed = { ...creating, status: "CREATE_COMPLETE", health: "complete" as const };
  const completedStacks = [stacks[0]!, completed];
  assert.ok(codes({ ...value, deployment: { ...conflict, stacks: completedStacks, state: { kind: "conflict", reason: "unmarked", stacks: completedStacks, message: "Still no identity" } } }).includes("CONFLICT"), "an unmarked completed stack is never dismissed as pending");
  for (const reason of ["inconsistent", "mixed", "mode"] as const) {
    assert.ok(codes({ ...value, deployment: { ...conflict, state: { kind: "conflict", reason, stacks, message: "Real ownership conflict" } } }).includes("CONFLICT"));
  }
});

test("a target pinned to another account is refused for this profile", () => {
  const value = input({ name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: "111122223333" } });
  assert.deepEqual(codes(value), ["ACCOUNT_CONFLICT"]);
  assert.match(deploymentFindings(value)[0]!.detail ?? "", /111122223333/);
});

test("saved settings for an absent deployment do not warn when local runtime is stopped", () => {
  for (const client of [false, true]) {
    const value = input({ local: local({ exported: { deployment: "my-aws-app", client } }) });
    assert.deepEqual(codes(value), ["TARGET_ABSENT"]);
    assert.equal(nextAction(deploymentFindings(value))?.id, "deploy");
    assert.equal(deploymentFindings(value).flatMap(finding => finding.actions).some(action => ["start", "start-exported", "resume-watch"].includes(action.id)), false);
  }
});

test("active local runtime still warns if its deployment is absent", () => {
  for (const startedBy of ["studio", "outside"] as const) {
    const value = input({ local: local({ startedBy, watch: { running: true }, exported: { deployment: "my-aws-app", client: true } }) });
    const orphan = deploymentFindings(value).find(finding => finding.code === "EXPORT_ORPHAN");
    assert.equal(orphan?.severity, "attention");
    assert.match(orphan?.title ?? "", /Local runtime is active/);
    assert.match(orphan?.detail ?? "", /requires a fully completed development deployment/);
    assert.ok(orphan?.actions.some(action => action.id === "stop"));
    assert.equal(orphan?.actions.some(action => ["start", "start-exported", "resume-watch"].includes(action.id)), false);
  }
});

test("while an operation runs on the deployment, its other cloud actions wait", () => {
  const value = input({ jobs: [{ id: "j1", kind: "deploy-apply", title: "Apply plan to my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 3, deployment: "my-aws-app" }] });
  assert.equal(codes(value)[0], "OPERATION_RUNNING");
  assert.equal(nextAction(deploymentFindings(value)), undefined);
  assert.ok(deploymentFindings(value).flatMap((finding) => finding.actions).filter((action) => action.id === "deploy").every((action) => action.disabled));
});

test("production export keeps its operation progress without development findings", () => {
  const name = "my-aws-app-prod";
  const stacks: StackView[] = [{ ...stack(`${name}-CognitoStack`), identity: { deployment: name, mode: "prod", contract: 2 } }];
  const value = input({ name, target: { name, mode: "prod", origin: "declared" },
    deployment: deployed({ name, mode: "prod", stacks, state: { kind: "ready", stacks } }),
    jobs: [{ id: "prod-export", kind: "export", title: `Export ${name}'s outputs`, deployment: name, params: {}, status: "running", startedAt: "2026-11-09T10:00:00Z", lastSeq: 1 }],
  });
  const findings = deploymentFindings(value);
  assert.deepEqual(codes(value), ["OPERATION_RUNNING", "DEPLOYED"]);
  assert.equal(findings[0]?.title, `Export ${name}'s outputs`);
  assert.equal(nextAction(findings), undefined);
  assert.ok(findings.flatMap(finding => finding.actions).every(action => action.disabled));
});

test("an undeclared development deployment retains export operation progress", () => {
  const value = input({ target: undefined, deployment: deployed(),
    jobs: [{ id: "undeclared-export", kind: "export", title: "Export undeclared development outputs", deployment: "my-aws-app", params: {}, status: "running", startedAt: "2026-11-09T10:00:00Z", lastSeq: 1 }],
  });
  const findings = deploymentFindings(value);
  assert.ok(codes(value).includes("OPERATION_RUNNING"));
  assert.equal(codes(value).includes("LOCAL_OPERATION_RUNNING"), false);
  assert.equal(findings[0]?.title, "Export undeclared development outputs");
  assert.equal(nextAction(findings), undefined);
  assert.ok(findings.flatMap(finding => finding.actions).every(action => action.disabled));
});

test("failed stacks CloudFormation can recover are redeployed; a stuck rollback is not offered a deploy", () => {
  const failed = deployed({ state: { kind: "failed", deployable: true, stacks: [stack("my-aws-app-CognitoStack", "ROLLBACK_COMPLETE", "failed-create")] } });
  assert.equal(nextAction(deploymentFindings(input({ deployment: failed })))?.id, "deploy");
  const stuck = deployed({ state: { kind: "failed", deployable: false, stacks: [stack("my-aws-app-CognitoStack", "UPDATE_ROLLBACK_FAILED", "failed")] } });
  const findings = deploymentFindings(input({ deployment: stuck }));
  assert.equal(findings[0]?.severity, "blocking");
  assert.equal(findings.flatMap((finding) => finding.actions).some((action) => action.id === "deploy"), false);
});

test("a deployment discovered in the account but not declared here is read-only", () => {
  const value = input({ name: "alex-dev", target: undefined, deployment: deployed({ name: "alex-dev" }) });
  assert.ok(codes(value).includes("NOT_DECLARED"));
  assert.equal(deploymentFindings(value).flatMap((finding) => finding.actions).some((action) => ["deploy", "plan", "start", "export"].includes(action.id)), false);
});

const runningPlan = { key: "my-aws-app-abc123", deployment: "my-aws-app", mode: "dev" as const, status: "ready" as const, createdAt: "2026-10-17T10:00:00Z", expired: false };
const planJob = (kind: "deploy-plan" | "deploy-apply" | "deploy-discard", title: string) => ({ id: "j2", kind, title, params: {}, status: "running" as const, startedAt: "2026-10-17T10:01:00Z", lastSeq: 1, deployment: "my-aws-app", planId: runningPlan.key });

for (const [kind, title, progress] of [["deploy-apply", "Apply plan to my-aws-app", "Deploying this plan…"], ["deploy-discard", "Discard plan for my-aws-app", "Discarding this plan…"]] as const) {
  test(`a plan under ${kind} stays where it is and says so, with nothing offered`, () => {
    const card = deploymentFindings(input({ deployment: deployed(), plans: [runningPlan], jobs: [planJob(kind, title)] })).find(finding => finding.code === "PLAN_WAITING");
    assert.equal(card?.title, progress);
    assert.equal(card?.severity, "info", "progress is not a warning");
    assert.ok(card?.actions.length && card.actions.every(action => action.disabled));
  });
}

test("the plan a synthesis is still writing is not offered yet", () => {
  const value = input({ deployment: deployed(), plans: [runningPlan], jobs: [planJob("deploy-plan", "Synthesize my-aws-app")] });
  assert.equal(codes(value).includes("PLAN_WAITING"), false);
});

test("a ready plan is a result, not a warning; a plan that still wants something is attention", () => {
  const severity = (plan: Partial<typeof runningPlan> & { readonly retainedStacks?: number; readonly synthesis?: { readonly current: boolean } }) =>
    deploymentFindings(input({ deployment: deployed(), plans: [{ ...runningPlan, ...plan }] })).find(finding => finding.code === "PLAN_WAITING")?.severity;
  assert.equal(severity({}), "info");
  assert.equal(severity({ status: "no-changes" as never }), "info");
  assert.equal(severity({ status: "needs-secrets" as never }), "attention");
  assert.equal(severity({ status: "blocked" as never }), "attention");
  assert.equal(severity({ synthesis: { current: false } }), "attention");
  assert.equal(severity({ retainedStacks: 2 }), "attention");
});

test("stacks created only to hold a plan's change sets await review; they are not CloudFormation at work", () => {
  const review = [stack("my-aws-app-CognitoStack", "REVIEW_IN_PROGRESS", "review")];
  const value = input({
    deployment: deployed({ stacks: review, state: { kind: "in-progress", deployable: false, stacks: review } }),
    plans: [{ key: "my-aws-app-abc123", deployment: "my-aws-app", mode: "dev", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false }],
  });
  assert.ok(codes(value).includes("AWAITING_REVIEW"));
  assert.equal(codes(value).includes("IN_PROGRESS"), false);
  assert.equal(nextAction(deploymentFindings(value))?.id, "review-plan");
});

test("after a partial apply, the stacks still to plan are offered next", () => {
  const value = input({
    name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account },
    deployment: deployed({ name: "my-aws-app-prod", mode: "prod" }),
    plans: [{ key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "ready", createdAt: "2026-10-17T10:00:00Z", expired: false, applied: "partial", deferred: ["my-aws-app-prod-RdsStack", "my-aws-app-prod-CognitoStack"] }],
  });
  const partial = deploymentFindings(value).find((finding) => finding.code === "PLAN_PARTIAL");
  assert.match(partial?.detail ?? "", /RdsStack, CognitoStack/);
  assert.deepEqual([nextAction(deploymentFindings(value))?.id, nextAction(deploymentFindings(value))?.label], ["plan", "Plan the remaining stacks"]);
});

test("while a local operation runs, expected progress replaces ready and settings cards", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const value = input({ deployment: deployed(), detail: ready, local: local({ exported: { deployment: "my-aws-app", client: true } }), jobs: [{ id: "j3", kind: "local-start", title: "Start development against my-aws-app", deployment: "my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 1, steps: [{ label: "Start local application containers", status: "running" }] }] });
  const progress = deploymentFindings(value).find(finding => finding.code === "LOCAL_OPERATION_RUNNING");
  assert.deepEqual(codes(value), ["DEPLOYED", "LOCAL_OPERATION_RUNNING"]);
  assert.equal(progress?.severity, "info");
  assert.match(progress?.detail ?? "", /Start local application containers/);
  assert.deepEqual(progress?.actions, []);
  assert.equal(nextAction(deploymentFindings(value))?.id, undefined);
});

test("startup and shutdown progress reconcile independent file and container observations", () => {
  const detail = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { client: false, fresh: false } } };
  const states = [local(), local({ exported: { deployment: "my-aws-app", client: true } }), local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, services: [{ name: "api", container: "api", state: "running", health: "starting", oneShot: false, ports: "" }] })];
  for (const kind of ["local-start", "local-stop", "local-restart", "local-attach-watch", "export"] as const) {
    const running: JobView = { id: "j3", kind, title: `Running ${kind}`, deployment: "my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 1 };
    for (const state of states) {
      const value = input({ deployment: deployed(), detail, local: state, jobs: [running] });
      assert.deepEqual(codes(value), ["DEPLOYED", "LOCAL_OPERATION_RUNNING"]);
      assert.ok(deploymentFindings(value).every(finding => finding.severity === "info"));
      assert.equal(nextAction(deploymentFindings(value)), undefined);
      if (kind === "export") {
        const progress = deploymentFindings(value).find(finding => finding.code === "LOCAL_OPERATION_RUNNING");
        assert.equal(progress?.title, "Generating client environment");
        assert.match(progress?.detail ?? "", /Writing client-app\/\.env\.development\.local/);
      }
    }
  }
  const failed: JobView = { id: "j3", kind: "local-start", title: "Start development", deployment: "my-aws-app", params: {}, status: "failed", startedAt: "2026-10-17T10:00:00Z", lastSeq: 1 };
  const failure = input({ deployment: deployed(), detail, local: states[2]!, jobs: [failed] });
  assert.ok(codes(failure).includes("EXPORT_STALE"), "a finished attempt exposes remaining recovery needs");
  assert.ok(codes(failure).includes("WATCH_DETACHED"));
  assert.equal(codes(failure).includes("LOCAL_OPERATION_RUNNING"), false);
});

test("local progress preserves real incompatibility and other-runtime destination evidence", () => {
  const running: JobView = { id: "j3", kind: "local-start", title: "Start development", deployment: "my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00Z", lastSeq: 1 };
  const value = input({ deployment: deployed(), jobs: [running],
    detail: { ...deployed(), events: [], changeSets: [], local: { compatible: false, problem: "Deploy current source first.", exported: { client: false, fresh: false } } } });
  assert.ok(codes(value).includes("LOCAL_INCOMPATIBLE"));
  const other = input({ deployment: deployed(), jobs: [running], local: local({ startedBy: "studio", exported: { deployment: "other-dev", client: true } }) });
  assert.ok(codes(other).includes("LOCAL_ELSEWHERE"));
  const stop = deploymentFindings(other).find(finding => finding.code === "LOCAL_ELSEWHERE")?.actions.find(action => action.id === "stop");
  assert.match(stop?.disabled ?? "", /Start development is running/);
  const elsewhere = { ...other, jobs: [{ ...running, deployment: "other-dev" }] };
  assert.ok(codes(elsewhere).includes("LOCAL_ELSEWHERE"));
  assert.equal(codes(elsewhere).includes("LOCAL_OPERATION_RUNNING"), false, "another target's operation is not this target's startup");
});

test("same-name local operations cannot replace another profile, account or region's findings", () => {
  const running: JobView = { id: "j3", kind: "local-start", title: "Start development", deployment: "my-aws-app",
    params: { profile: "dev", account: context.account, region: context.region }, status: "running", startedAt: "2026-11-09T10:00:00Z", lastSeq: 1 };
  const value = input({ deployment: deployed(), jobs: [running],
    detail: { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", client: true, fresh: false } } },
    local: local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, watch: { running: true }, client: { running: true } }),
  });
  assert.deepEqual(codes(value), ["DEPLOYED", "LOCAL_OPERATION_RUNNING"], "a matching captured destination produces one progress finding");
  for (const params of [{ profile: "other" }, { account: "111122223333" }, { region: "us-west-2" }]) {
    const mismatch = { ...value, jobs: [{ ...running, params: { ...running.params, ...params } }] };
    const findings = deploymentFindings(mismatch);
    assert.ok(codes(mismatch).includes("OPERATION_RUNNING"), "the running operation remains indicated");
    assert.equal(codes(mismatch).includes("LOCAL_OPERATION_RUNNING"), false, "another destination's operation cannot claim this destination is starting");
    const stale = findings.find(finding => finding.code === "EXPORT_STALE");
    assert.equal(stale?.severity, "attention", "destination changes do not conceal existing settings conflicts");
    assert.ok(stale?.actions.every(action => action.disabled));
    assert.equal(nextAction(findings), undefined);
  }
  const selectedProfile = { ...value, profile: "other" };
  assert.equal(codes(selectedProfile).includes("LOCAL_OPERATION_RUNNING"), false, "the selected profile takes precedence over older observed profile metadata");
  assert.ok(codes(selectedProfile).includes("EXPORT_STALE"));
});

test("when the watch has stopped on its own, the finding says why", () => {
  const ready = { ...deployed(), events: [], changeSets: [], local: { compatible: true, exported: { deployment: "my-aws-app", manifest: "my-aws-app", client: true, fresh: true } } };
  const value = input({ deployment: deployed(), detail: ready, local: local({ startedBy: "studio", exported: { deployment: "my-aws-app", client: true }, watch: { running: false, exitCode: 1, summary: "no such service: api" }, client: { running: true } }) });
  assert.match(deploymentFindings(value).find((finding) => finding.code === "WATCH_DETACHED")?.detail ?? "", /The watch stopped: no such service: api/);
});

test("a plan that stopped after preparing change sets is offered for discarding", () => {
  const value = input({
    name: "my-aws-app-prod", target: { name: "my-aws-app-prod", mode: "prod", origin: "declared", account: context.account },
    plans: [{ key: "my-aws-app-prod-abc123", deployment: "my-aws-app-prod", mode: "prod", status: "unfinished", createdAt: "2026-10-17T10:00:00Z", expired: false }],
  });
  const unfinished = deploymentFindings(value).find((finding) => finding.code === "PLAN_UNFINISHED");
  assert.deepEqual(unfinished?.actions.map((action) => [action.id, action.plan]), [["discard-plan", "my-aws-app-prod-abc123"]]);
  assert.equal(codes(value).includes("PLAN_WAITING"), false, "there is nothing to review");
});

test("a deployment read from another region than its pin offers nothing to do there", () => {
  const value = input({
    target: { name: "my-aws-app", mode: "dev", origin: "implicit", region: "us-west-2" },
    match: { name: "my-aws-app", mode: "dev", origin: "implicit", region: "us-west-2", status: "elsewhere", detail: "Pinned to 222233334444/us-west-2; the selected profile is 222233334444/us-east-1." },
  });
  assert.equal(codes(value).includes("TARGET_ABSENT"), false, "absence in this region says nothing about the pinned one");
  assert.equal(deploymentFindings(value).flatMap((finding) => finding.actions).some((action) => action.id === "deploy" || action.id === "delete"), false);
});

test("a failed verification is persistent recovery evidence, while another account's plan is excluded", () => {
  const plan = { key: "saved-review-abc123", deployment: "my-aws-app", mode: "dev" as const, account: context.account, region: context.region, status: "ready" as const, createdAt: "2026-10-22T10:00:00Z", expired: false, applied: "unverified" as const };
  const ours = input({ deployment: deployed(), plans: [plan] });
  const recovery = deploymentFindings(ours).find((finding) => finding.code === "OPERATION_UNVERIFIED");
  assert.equal(recovery?.severity, "blocking");
  assert.equal(nextAction(deploymentFindings(ours))?.plan, plan.key);
  assert.equal(deploymentFindings(ours).some((finding) => /^Deployed ·/.test(finding.title)), false);
  const foreign = input({ deployment: deployed(), plans: [{ ...plan, account: "111122223333" }] });
  assert.equal(codes(foreign).includes("OPERATION_UNVERIFIED"), false);
});

const APP = "5b7e3c1a-9d2f-4e6b-8a1c-3f0d2e9b7a64";

test("a production stage deployed under another name blocks deploying the new one and offers to keep that name", () => {
  const target = { name: "acme-prod", mode: "prod" as const, origin: "declared" as const, stage: "prod", appId: APP, account: context.account };
  const value = input({ name: "acme-prod", target, match: { ...target, status: "absent", deployedAs: "aws-studio-prod" } });
  const findings = deploymentFindings(value);
  assert.deepEqual(findings.map((finding) => [finding.code, finding.severity, finding.title]), [["STAGE_DEPLOYED_AS", "blocking", "Deployed as aws-studio-prod"]]);
  assert.match(findings[0]!.detail ?? "", /prod stage is already deployed here under that name, with its users, database and secrets\. Deploying acme-prod would start a second production beside it/);
  const action = nextAction(findings);
  assert.deepEqual([action?.id, action?.label, action?.deployAs], ["deploy-as", "Keep deploying to aws-studio-prod", "aws-studio-prod"], "keeping the name comes first; no plan is offered");
});

test("a development stage deployed under another name notes it, offers to keep it, and still deploys fresh", () => {
  const target = { name: "acme-dev", mode: "dev" as const, origin: "implicit" as const, stage: "dev", appId: APP };
  const findings = deploymentFindings(input({ name: "acme-dev", target, match: { ...target, status: "absent", deployedAs: "aws-studio-dev" } }));
  const earlier = findings.find((finding) => finding.code === "STAGE_DEPLOYED_AS")!;
  assert.deepEqual([earlier.severity, earlier.title, earlier.actions.map((action) => action.label)], ["info", "Earlier deployment: aws-studio-dev", ["Keep deploying to aws-studio-dev"]]);
  assert.equal(nextAction(findings)?.label, "Compare AWS templates");
});

test("a discovered deployment of this app's own stage says so, rather than calling itself undeclared", () => {
  const old = deployed({ name: "aws-studio-dev", appId: APP, stage: "dev" });
  const mine = deploymentFindings(input({ name: "aws-studio-dev", target: undefined, deployment: old, appId: APP })).find((finding) => finding.code === "NOT_DECLARED")!;
  assert.deepEqual([mine.title, mine.detail], ["An earlier deployment of this app's dev stage", "cdk-app/cdk.json no longer deploys the dev stage as aws-studio-dev. It keeps running, and billing, until you delete it."]);
  assert.deepEqual(mine.actions.map((action) => action.id), ["delete"]);
  const theirs = deploymentFindings(input({ name: "aws-studio-dev", target: undefined, deployment: old, appId: "0f0e0d0c-0b0a-4908-8706-050403020100" })).find((finding) => finding.code === "NOT_DECLARED")!;
  assert.equal(theirs.title, "Discovered in this account, not declared here");
});
