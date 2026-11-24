import { applicationVpc as fixtureVpc } from "../../../scripts/test-project-declarations";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCloudEdgesResolvable,
  defineFrameworkConfig,
  defineInputs, defineStacks,
  getCloudTargets,
  isTargetDeployed,
  isTargetEnabled,
  input, stack, cdk,
  runsTask,
  type FrameworkConfig,
  type FrameworkConfigInput,
} from "../src/config/index";
import { defaults } from "../../../scripts/test-project-declarations";

const cognito = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };
const webSocketRoles = ["webSocket", "webSocketAuthorizer"] as const;

const routes = {
  $connect: {
    directory: "compute/websocket/ws-connect-route",
    authorizer: { directory: "compute/websocket/ws-authorizer", environment: cognito },
  },
  $default: { directory: "compute/websocket/ws-default-route" },
  customAction: { directory: "compute/websocket/ws-custom-action-route" },
};

const config = (overrides: Partial<FrameworkConfigInput> = {}, defaultRoute: Record<string, unknown> = {}): FrameworkConfig =>
  defineFrameworkConfig({ networks: [fixtureVpc],
    defaults,
    http: [{ "/verify-session": { directory: "compute/http/verify-session", methods: ["GET"] } }],
    webSocket: [{ ...routes, $default: { ...routes.$default, ...defaultRoute } }],
    events: [],
    services: [],
    ...overrides,
  } as never);

test("only a prod deployment holds enabled WebSocket handlers; development runs them under Compose", () => {
  const built = config();
  assert.deepEqual(getCloudTargets(built, webSocketRoles, "dev", { }), []);

  const prod = getCloudTargets(built, webSocketRoles, "prod");
  assert.equal(prod.length, 4, "three routes and the $connect authorizer");
  assert.ok(prod.some((target) => target.role === "webSocketAuthorizer"));
  for (const id of ["ws-connect-route", "ws-authorizer", "ws-default-route", "ws-custom-action-route"]) {
    assert.equal(isTargetDeployed(built, "lambda", id, "dev", { }), false, id);
    assert.equal(isTargetDeployed(built, "lambda", id, "prod"), true, id);
    assert.equal(isTargetEnabled(built, "lambda", id, "local", "unconditioned"), true, `${id} still runs locally`);
  }
  assert.doesNotThrow(() => assertCloudEdgesResolvable(built, "dev", { }));
});

test("a WebSocket handler may start a task, sit in the VPC or reach the database: a dev deployment builds none of them", () => {
  const callsTask = config({ tasks: [{ worker: { cloud: { vpc: fixtureVpc }, directory: "compute/.cache/test-fixtures/task-worker", deploy: "both" } }] }, { cloud: { bindings: [runsTask("worker")] } });
  const inside = config({}, { vpc: fixtureVpc, subnet: "private" });
  const catalog = defineStacks({ rds: stack<{ readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } } }>() });
  const connected = config({ stacks: catalog, database: { resource: catalog.rds.database, vpc: fixtureVpc } } as never, { vpc: fixtureVpc, database: true });
  for (const built of [callsTask, inside, connected]) {
    assert.doesNotThrow(() => assertCloudEdgesResolvable(built, "prod", { }));
    assert.doesNotThrow(() => assertCloudEdgesResolvable(built, "dev", { }));
  }
});
