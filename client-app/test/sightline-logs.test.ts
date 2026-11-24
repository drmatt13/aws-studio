import assert from "./support/assert";
import { test } from "node:test";
import { buildSightline } from "../src/sightline/build";
import type { SightlineInputs } from "../src/sightline/types";
import { snapshot } from "./browser/support/scenarios";
import {
  logEvent,
  logEvidence,
  logTime,
  workflowLogModel,
} from "./support/development-logs";

function inputs(): SightlineInputs {
  return {
    capturedAt: logTime,
    pathname: "/",
    snapshot: snapshot().snapshot,
    mode: "dev",
    selected: "lambda:fixture-0",
    source: {
      latestRevision: "browser-revision",
      evaluating: false,
      dirty: false,
      conflicted: false,
      connected: true,
    },
    aliases: {},
    workspace: {},
    deployments: {
      dev: {
        availability: "missing-profile",
        observed: { availability: "not-loaded" },
      },
      prod: {
        availability: "missing-profile",
        observed: { availability: "not-loaded" },
      },
    },
    activity: { availability: "available", jobs: [] },
    developmentLogs: {
      availability: "available",
      evidence: logEvidence([logEvent()]),
    },
  };
}
test("Sightline includes real sanitized excerpts and useful bounded payloads without inspector state", () => {
  const value = inputs(),
    output = buildSightline(value),
    json = JSON.stringify(output);
  assert.ok(json.includes("Order lookup failed"));
  assert.ok(json.includes("order-7"));
  assert.ok(json.includes("[redacted]"));
  assert.equal(output.developmentLogs.collection, "collecting");
  assert.equal(
    JSON.stringify(value),
    JSON.stringify(inputs()),
    "Projection is pure",
  );
  assert.deepEqual(buildSightline(value), output);
  assert.ok(json.length <= 12_000);
});
test("production projection cannot leak development logs even when supplied cached development inputs", () => {
  const value = { ...inputs(), mode: "prod" as const };
  const output = buildSightline(value);
  assert.equal(output.developmentLogs.availability, "not-applicable");
  assert.ok(!JSON.stringify(output).includes("Order lookup failed"));
  assert.ok(!JSON.stringify(output).includes("fixture-runtime-1"));
});

test("Sightline includes locally invoked workflow event Lambda evidence without enabling AWS event evidence", () => {
  const base = inputs(),
    source = {
      ...base,
      snapshot: {
        ...base.snapshot,
        models: {
          ...base.snapshot.models,
          dev: workflowLogModel(base.snapshot.models.dev),
        },
      },
    };
  const focused = buildSightline(source);
  assert.equal(focused.developmentLogs.availability, "available");
  assert.equal(focused.developmentLogs.coverage, "partial");
  assert.match(
    String(focused.developmentLogs.coverageReason),
    /AWS event-triggered executions are not collected/,
  );
  assert.ok(
    JSON.stringify(focused.developmentLogs).includes("Order lookup failed"),
  );
  const aws = buildSightline({
    ...source,
    selected: "lambda:aws-only-fixture",
  });
  assert.equal(aws.developmentLogs.availability, "not-applicable");
  assert.ok(
    !JSON.stringify(aws.developmentLogs).includes("Order lookup failed"),
  );
});
test("overview and focused log budgets deterministically record omissions and retain useful failure evidence", () => {
  const value: SightlineInputs = {
    ...inputs(),
    developmentLogs: {
      availability: "available",
      evidence: logEvidence(
        Array.from({ length: 24 }, (_, index) =>
          logEvent(index + 1, {
            message: "Failure evidence ".repeat(200),
            details: { safe: "payload ".repeat(500) },
          }),
        ),
      ),
    },
  };
  for (const selected of [undefined, "lambda:fixture-0"]) {
    const output = buildSightline({ ...value, selected });
    assert.ok(JSON.stringify(output).length <= 12_000);
    assert.ok(
      JSON.stringify(output.developmentLogs).includes("Failure evidence"),
    );
    assert.ok(
      output.omitted.some(
        (item) =>
          item.path.startsWith("developmentLogs") && item.reason === "budget",
      ),
    );
  }
});

test("selected workflow and tool evidence retain their execution/session correlation before generic request IDs", () => {
  const base = inputs(),
    original = base.snapshot.models.dev.targets[0]!;
  const workflow = {
    ...original,
    ref: "workflow:review",
    id: "review",
    kind: "workflow" as const,
    role: "workflow" as const,
    compute: {
      kind: "workflow" as const,
      type: "standard" as const,
      timeoutSeconds: 10,
      steps: 1,
    },
  };
  const source = {
    ...base,
    selected: workflow.ref,
    snapshot: {
      ...base.snapshot,
      models: {
        ...base.snapshot.models,
        dev: {
          ...base.snapshot.models.dev,
          targets: [...base.snapshot.models.dev.targets, workflow],
        },
      },
    },
    developmentLogs: {
      availability: "available" as const,
      evidence: logEvidence([
        logEvent(1, {
          resource: { id: workflow.ref, kind: "workflow" },
          correlation: {
            traceId: "trace",
            requestId: "request",
            invocationId: "invocation",
            executionId: "execution",
            stateId: "state",
            parentSpanId: "parent",
          },
        }),
      ]),
    },
  };
  const workflowJson = JSON.stringify(buildSightline(source).developmentLogs);
  assert.ok(workflowJson.includes('"executionId":"execution"'));
  assert.ok(workflowJson.includes('"stateId":"state"'));
  const tool = {
    ...base,
    developmentLogs: {
      availability: "available" as const,
      evidence: logEvidence([
        logEvent(1, {
          correlation: {
            traceId: "trace",
            requestId: "request",
            invocationId: "invocation",
            agentSessionId: "session",
            turnId: "turn",
            toolCallId: "tool",
          },
        }),
      ]),
    },
  };
  const toolJson = JSON.stringify(buildSightline(tool).developmentLogs);
  assert.ok(toolJson.includes('"agentSessionId":"session"'));
  assert.ok(toolJson.includes('"toolCallId":"tool"'));
});
