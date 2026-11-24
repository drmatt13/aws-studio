import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFrameworkConfig, routeAllowsMethod, type FrameworkConfig, type HttpMethod } from "../src/config";
import { defaults } from "../../../scripts/test-project-declarations";
import { applicationVpc } from "../../../scripts/test-project-declarations";

function routes(http: string, service: string, methods: readonly [HttpMethod, ...HttpMethod[]] = ["GET"]): FrameworkConfig {
  return { defaults, resources: {}, networks: [applicationVpc], http: { [http]: { directory: "compute/http/handler", methods: ["GET"] } },
    services: { [service]: { directory: "compute/services/service", port: 8000, methods, cloud: { vpc: applicationVpc } } },
    webSocket: {}, events: {},
  };
}

test("literal and mount overlap respects root, segments, case and methods", () => {
  for (const [http, service] of [["/", "/"], ["/", "/*"], ["/api", "/api"], ["/api", "/api/*"], ["/api/child", "/api/*"]]) {
    assert.throws(() => normalizeFrameworkConfig(routes(http!, service!)), {
      message: `HTTP routes http["${http}"] (lambda:handler) and services["${service}"] (service:service) both accept GET ${http}. One request belongs to one route.`,
    });
    assert.doesNotThrow(() => normalizeFrameworkConfig(routes(http!, service!, ["POST"])));
  }
  for (const [http, service] of [["/", "/api"], ["/api", "/API"], ["/apis", "/api/*"], ["/api", "/api/child/*"]]) {
    assert.doesNotThrow(() => normalizeFrameworkConfig(routes(http!, service!)));
  }
});

test("opt-in HEAD shares the GET Lambda and participates in route conflict checks", () => {
  const config = routes("/reports", "/reports", ["POST"]);
  const definition = { ...config.http["/reports"]!, head: true };
  const normalized = normalizeFrameworkConfig({ ...config, http: { "/reports": definition } });
  const lambda = normalized.http.find(route => route.type === "lambda")!;
  assert.deepEqual(lambda.methods, ["GET", "HEAD"]);
  assert.equal(lambda.target, "handler");
  assert.equal(routeAllowsMethod(lambda, "HEAD"), true);
  assert.throws(() => normalizeFrameworkConfig({ ...routes("/reports", "/reports", ["HEAD"]), http: { "/reports": definition } }), /both accept HEAD \/reports/);
  assert.throws(() => normalizeFrameworkConfig({ ...config, http: { "/reports": { ...definition, methods: ["POST"] } } }), /head requires an explicit GET/);
});
