import { test, expect, assertAccessible } from "./support/test";
import { NOW } from "./support/scenarios";
import { installLocalRuntime, localRuntimeView } from "./support/local-runtime";
import type { JobView, OperationRequest } from "../../shared/deploy";

for (const width of [1440, 390]) test(`client environment generation is separate and optional before startup at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  studio.reply("POST", "/api/deploy/operations", async route => {
    const request = route.request().postDataJSON() as OperationRequest;
    runtime.submitted.push(request);
    const exporting = request.kind === "export";
    const job: JobView = { id: `fixture-client-env-${runtime.submitted.length}`, kind: request.kind, params: request.params,
      deployment: "browser-dev", title: exporting ? "Generate client environment for browser-dev" : "Start development against browser-dev",
      status: "running", startedAt: NOW, lastSeq: 0,
      steps: [{ label: "Generate client-app/.env.development.local", status: "running" }] };
    runtime.jobs.unshift(job);
    studio.reply("GET", `/api/operations/${job.id}/log`, log => log.fulfill({ json: { job: runtime.jobs.find(entry => entry.id === job.id), lines: [] } }));
    await route.fulfill({ json: job });
  });
  await studio.goto("/deploy");
  const environment = page.getByRole("article").filter({ has: page.getByText("Client environment", { exact: true }) });
  const readiness = page.getByRole("article").filter({ has: page.getByText("Ready to run locally", { exact: true }) });
  await expect(environment).toBeVisible();
  await expect(environment).toContainText("client-app/.env.development.local");
  await expect(environment).toContainText("framework-config/client-environment.ts");
  await expect(environment).toContainText("cdk-app/.env.dev");
  await expect(environment).toContainText(/CloudFormation/);
  await expect(readiness).toContainText(/automatically regenerates.*before.*Docker Compose/);
  await expect(readiness.getByRole("button")).toHaveCount(1);
  const generate = environment.getByRole("button", { name: "Generate .env file", exact: true });
  await expect(generate).toBeEnabled();
  expect((await environment.boundingBox())!.y).toBeLessThan((await readiness.boundingBox())!.y);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("client-environment-and-local-start.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await generate.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => runtime.submitted.length).toBe(1);
  expect(runtime.submitted[0]).toMatchObject({ kind: "export", params: { deployment: "browser-dev", profile: "browser" } });
  const progress = page.getByRole("article").filter({ hasText: "Generating client environment" });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("client-app/.env.development.local");
  await expect(environment).toHaveCount(0);
  await expect(readiness).toHaveCount(0);
  await runtime.finish(localRuntimeView());
  await expect(environment).toBeVisible();
  await expect(readiness).toBeVisible();

  const start = readiness.getByRole("button", { name: "Start development", exact: true });
  await start.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.length).toBe(2);
  expect(runtime.submitted[1]).toMatchObject({ kind: "local-start", params: { deployment: "browser-dev", profile: "browser" } });
  await expect(environment).toHaveCount(0);
  await expect(readiness).toHaveCount(0);
  await runtime.finish(localRuntimeView("ready"));
  await expect(page.getByRole("article").filter({ hasText: "Running · 1 service" })).toBeVisible();
  expect(runtime.submitted.map(request => request.kind)).toEqual(["export", "local-start"]);
  await assertAccessible(page);
});

test("failed environment generation leaves a retry available without starting compute", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.reject("The deployment outputs could not be read. Check the selected AWS profile and try again.");
  await studio.goto("/deploy");
  const environment = page.getByRole("article").filter({ has: page.getByText("Client environment", { exact: true }) });
  const generate = environment.getByRole("button", { name: "Generate .env file", exact: true });
  await generate.click();
  await expect(page.getByText("The deployment outputs could not be read. Check the selected AWS profile and try again.", { exact: true }).first()).toBeVisible();
  await expect(generate).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start development", exact: true })).toBeEnabled();
  expect(runtime.submitted.map(request => request.kind)).toEqual(["export"]);
  await assertAccessible(page);
});
