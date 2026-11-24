import assert from "./support/assert";
import { test } from "node:test";
import { developmentLogScope } from "../shared/development-log-scope";
import { snapshot } from "./browser/support/scenarios";
import { workflowLogModel } from "./support/development-logs";

test("log scopes use canonical model identities and keep routes separate from targets", () => {
  const model = snapshot().snapshot.models.dev;
  assert.equal(
    developmentLogScope(model, model.targets[0]!.ref)?.kind,
    "captured",
  );
  const route = model.routes[0]!;
  const scope = developmentLogScope(model, route.id)!;
  assert.equal(scope.resourceId, route.id);
  assert.equal(scope.routeId, route.id);
  assert.ok(scope.resourceIds.includes(route.target));
  assert.ok(scope.resourceIds.includes(route.id));
  assert.equal(
    developmentLogScope(model, "gateway:http")?.resourceId,
    "gateway:http",
  );
  assert.equal(developmentLogScope(model, "lambda:not-declared"), undefined);
});

test("agent route scopes include canonical route journal copies without inventing API Gateway membership", () => {
  const model = snapshot().snapshot.models.dev,
    base = model.targets[0]!;
  const agent = {
    ...base,
    ref: "agent:route-fixture",
    id: "route-fixture",
    kind: "agent" as const,
    role: "agent" as const,
    compute: {
      kind: "agent" as const,
      auth: true,
      route: "/chat/route-fixture",
      gateways: [],
    },
  };
  const route = {
    id: "route:agent:/chat/route-fixture",
    kind: "agent" as const,
    path: "/chat/route-fixture",
    target: agent.ref,
    auth: true,
    origin: 'agents["route-fixture"].route',
  };
  const scope = developmentLogScope(
    {
      ...model,
      targets: [...model.targets, agent],
      routes: [...model.routes, route],
    },
    route.id,
  )!;
  assert.equal(scope.kind, "captured");
  assert.deepEqual(scope.resourceIds, [route.id, agent.ref]);
  assert.equal(scope.routeId, route.id);
});

test("configuration entities do not acquire fake execution streams", () => {
  const model = snapshot().snapshot.models.dev;
  for (const kind of [
    "input",
    "secret",
    "group",
    "envFile",
    "stack",
  ] as const) {
    const id = `resource:test-${kind}`;
    const updated = {
      ...model,
      resources: [
        ...model.resources,
        { id, kind, path: [kind], absent: false },
      ],
    };
    assert.equal(developmentLogScope(updated, id)?.kind, "not-applicable");
  }
  assert.equal(
    developmentLogScope(model, "island:lambda")?.kind,
    "not-applicable",
  );
});

test("AWS-only event handlers are explicitly unavailable until replay reaches local execution", () => {
  const model = snapshot().snapshot.models.dev;
  const original = model.targets[0]!;
  if (original.compute.kind !== "lambda")
    throw new Error("Expected Lambda fixture");
  const target = {
    ...original,
    role: "event" as const,
    compute: { ...original.compute, localReplay: undefined },
    lanes: { ...original.lanes, local: false },
  };
  assert.equal(
    developmentLogScope({ ...model, targets: [target] }, target.ref)?.kind,
    "unsupported",
  );
  assert.equal(
    developmentLogScope(
      {
        ...model,
        targets: [
          { ...target, compute: { ...target.compute, localReplay: true } },
        ],
      },
      target.ref,
    )?.kind,
    "captured",
  );
});

test("event Lambda workflow steps expose local evidence independently of replay and AWS triggers", () => {
  const model = workflowLogModel(snapshot().snapshot.models.dev),
    step = model.targets[0]!;
  const scope = developmentLogScope(model, step.ref)!;
  assert.equal(scope.kind, "partial");
  assert.match(scope.reason!, /Local workflow invocations are captured/);
  assert.deepEqual(scope.resourceIds, [step.ref]);
  assert.equal(
    developmentLogScope(model, "lambda:aws-only-fixture")?.kind,
    "unsupported",
  );
  assert.equal(
    developmentLogScope({ ...model, workflows: [] }, step.ref)?.kind,
    "partial",
    "Source-projected step edges supply the same authoritative relationship",
  );
  assert.equal(
    developmentLogScope(
      {
        ...model,
        targets: model.targets.map((target) =>
          target.kind === "workflow"
            ? { ...target, lanes: { ...target.lanes, local: false } }
            : target,
        ),
      },
      step.ref,
    )?.kind,
    "unsupported",
  );
});

test("native resource partial scope comes from enabled local workflow integrations", () => {
  const base = workflowLogModel(snapshot().snapshot.models.dev);
  const resource = {
    id: "resource:fixture0.table",
    kind: "member" as const,
    path: ["fixture0", "table"],
    parent: "resource:fixture0",
    typeText: "dynamodb.Table",
    absent: false,
  };
  const ordinary = {
    ...resource,
    id: "resource:fixture0.cognito",
    path: ["fixture0", "cognito"],
    typeText: "cognito.UserPool",
  };
  const model = {
    ...base,
    resources: [...base.resources, resource, ordinary],
    workflows: base.workflows.map((workflow) => ({
      ...workflow,
      integrations: [
        {
          key: "dynamodb:fixture",
          resource: resource.id,
          operations: ["get"],
          awaitsCallback: false,
        },
      ],
    })),
  };
  assert.equal(developmentLogScope(model, resource.id)?.kind, "partial");
  assert.equal(developmentLogScope(model, ordinary.id)?.kind, "unsupported");
  const disabled = {
    ...model,
    targets: model.targets.map((target) =>
      target.kind === "workflow"
        ? { ...target, lanes: { ...target.lanes, local: false } }
        : target,
    ),
  };
  assert.equal(developmentLogScope(disabled, resource.id)?.kind, "unsupported");
});
