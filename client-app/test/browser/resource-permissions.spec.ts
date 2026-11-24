import type { DraftEdit } from "../../shared/api";
import type { ModelResource } from "../../shared/model";
import { withConnectionAuthorizations } from "../../shared/permissions";
import { test, expect, assertAccessible, type StudioFixture } from "./support/test";
import { location } from "./support/scenarios";

const destination = "resource:fixture0.files";
function install(studio: StudioFixture) {
  const member: ModelResource = { id: destination, path: ["fixture0", "files"], kind: "member", nativeKind: "resource", parent: "resource:fixture0", absent: false, typeText: "s3.IBucket", memberSource: "class" };
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.resources.find(resource => resource.id === "resource:fixture0")!, { kind: "stack", stackClass: "FixtureStack0", stackUsage: { status: "referenced", sites: [location] } });
    Object.assign(model, { resources: [...model.resources, member, { id: "resource:region", path: ["region"], kind: "input", absent: false, fromEnv: "APP_REGION" }], edges: [...model.edges,
      { id: "legacy-read", from: "lambda:fixture-0", to: destination, relation: "grant", provenance: "declared", label: "grantReadWrite", permissionContext: { kind: "native", method: "grantReadWrite", arguments: [] } },
    ] });
    Object.assign(model, withConnectionAuthorizations(model));
  }
  Object.assign(studio.response.snapshot.source, { permissionCapabilities: [{ resource: destination, stack: "resource:fixture0", category: "resource", canonicalTypes: ["aws-s3:IBucket"], attributes: ["bucketArn"], grants: [{ method: "grantReadWrite", parameters: [{name:"objectsKeyPattern",type:"string",optional:true}] }], location }] });
}

for (const width of [1440, 390]) test(`native permissions select actions and limits through reviewed source at ${width}px`, async ({ page, studio }, info) => {
  test.setTimeout(60_000);
  install(studio);
  await page.setViewportSize({ width, height: 1000 });
  let requested: Extract<DraftEdit, { kind: "connection" }> | undefined;
  studio.reply("POST", "/api/edits/batch/plan", async route => {
    requested = route.request().postDataJSON().edits[0];
    const text = `resourceAccess(stacks.fixture0.files, ${JSON.stringify({ actions: requested!.actions, limits: requested!.limits })})`;
    await route.fulfill({ json: { planId: "permissions", ok: true, summaries: ["Update application resource access"], changes: [{ file: "framework-config/workloads/http.ts", diff: { unified: `+ ${text}`, lines: [{ kind: "add", text, newLine: 1 }] } }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, impact: [] } });
  });
  studio.reply("POST", "/api/edits/batch/apply", async route => {
    for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, withConnectionAuthorizations({ ...model, edges: [...model.edges,
      { id: "new-access", from: "lambda:fixture-0", to: destination, relation: "grant", provenance: "declared", label: requested!.actions!.join(", "), permissionContext: { kind: "resourceAccess", actions: requested!.actions!, limits: requested!.limits } },
    ] }));
    await route.fulfill({ json: { status: "applied", revision: studio.response.snapshot.revision, message: "Saved resource access." } });
  });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const summary = (title: string) => panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: new RegExp(`^${title}`) });
  await summary("Permissions").click();
  await summary("Resource permissions").click();
  await expect(summary("Access to this resource")).toBeVisible();
  await panel.getByRole("button", { name: "Add access", exact: true }).click();
  await expect(panel.getByRole("searchbox", { name: "Search configured resources", exact: true })).toBeFocused();
  await panel.getByRole("searchbox", { name: "Search configured resources", exact: true }).fill("files");
  const option = panel.getByRole("button", { name: /files · Amazon S3/ });
  await option.focus();
  await page.keyboard.press("Enter");
  const editor = panel.getByRole("group", { name: /Access to .*files/ });
  await expect(editor.getByRole("button", { name: "Stage access", exact: true })).toBeDisabled();
  await editor.getByRole("checkbox", { name: "Full access", exact: true }).check();
  await expect(editor.getByRole("checkbox", { name: "Delete objects", exact: true })).toBeChecked();
  await editor.getByRole("checkbox", { name: "Full access", exact: true }).uncheck();
  await editor.getByRole("checkbox", { name: "Write objects", exact: true }).check();
  await expect(editor.getByRole("checkbox", { name: "Delete objects", exact: true })).not.toBeChecked();
  await expect(editor.getByRole("checkbox", { name: "Full access", exact: true })).toHaveJSProperty("indeterminate", true);
  await editor.locator("summary").filter({ hasText: /^Limit access/ }).click();
  await editor.getByRole("switch", { name: "Limit to object prefix", exact: true }).click();
  await editor.getByRole("textbox", { name: "Prefix", exact: true }).fill("uploads/");
  await editor.getByRole("switch", { name: "Require HTTPS", exact: true }).click();
  await assertAccessible(page);
  await panel.screenshot({ path: info.outputPath("resource-permission-editor.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor.getByRole("button", { name: "Stage access", exact: true }).click();
  await expect(summary("Resource permissions")).toContainText("Modified");
  expect(studio.requests.filter(request => request.path.endsWith("/apply"))).toHaveLength(0);
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("resourceAccess");
  expect(requested).toMatchObject({ connection: "resourceAccess", actions: ["write"], limits: { objectPrefix: "uploads/", requireHttps: true } });
  expect(requested).not.toHaveProperty("previous");
  await dialog.getByRole("button", { name: "Apply All", exact: true }).click();
  await expect(dialog).toBeHidden();
  const rule = panel.locator("[data-slot=access-summary]").filter({ hasText: "Write objects" });
  await rule.locator(":scope > summary").click();
  await expect(rule).toContainText("Also granted by grantReadWrite");
  await expect(rule).toContainText("uploads/");
  await rule.getByRole("button", { name: "Edit access", exact: true }).click();
  const update = rule.getByRole("group", { name: /Access to .*files/ });
  await expect(update.getByRole("checkbox", { name: "Write objects", exact: true })).toBeChecked();
  await update.getByRole("checkbox", { name: "Delete objects", exact: true }).check();
  await update.getByRole("button", { name: "Stage changes", exact: true }).click();
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  expect(requested?.previous).toEqual({ actions: ["write"], limits: { objectPrefix: "uploads/", requireHttps: true } });
  expect(requested?.actions).toEqual(["delete", "write"]);
  await dialog.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  expect(studio.requests.filter(request => request.path.endsWith("/apply"))).toHaveLength(1);
  await summary("Access to this resource").click();
  const managed = panel.locator("[data-slot=access-summary]").filter({ hasText: "Managed by route" });
  await managed.locator(":scope > summary").click();
  await managed.getByRole("button", { name: "Inspect route", exact: true }).click();
  await expect(page).toHaveURL(/select=route%3Ahttp%3A%2Ffixture%2F0/);
});

for (const width of [1440, 390]) test(`permission stacks expand inline with connected children and retain search context at ${width}px`, async ({ page, studio }, info) => {
  install(studio);
  await page.setViewportSize({ width, height: 1000 });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  await panel.getByRole("button", { name: "Add access", exact: true }).click();
  const picker = panel.getByRole("group", { name: "Configured resources", exact: true });
  const stack = picker.getByRole("button", { name: /fixture0 · CDK stack/ });
  await expect(stack.locator("img")).toHaveAttribute("src", "/icons/aws/cloudformation.svg");
  await expect(stack).toHaveAttribute("aria-expanded", "false");
  await expect(picker.getByRole("button", { name: "Show all resources", exact: true })).toHaveCount(0);
  const count = await picker.getByRole("status").innerText();
  await stack.focus(); await page.keyboard.press("ArrowRight");
  await expect(stack).toHaveAttribute("aria-expanded", "true");
  const branch = stack.locator("..").locator(":scope > [data-slot=endpoint-children]");
  const file = branch.getByRole("button", { name: /files · Amazon S3/ });
  await expect(file).toBeVisible();
  await expect(picker.getByRole("status")).toHaveText(count);
  const geometry = await branch.evaluate(list => {
    const row = list.querySelector("li")!;
    const line = getComputedStyle(row, "::after");
    return { line: line.borderLeftWidth, indent: list.getBoundingClientRect().left - list.parentElement!.getBoundingClientRect().left };
  });
  expect(geometry.line).toBe("1px"); expect(geometry.indent).toBeGreaterThan(0);
  await page.keyboard.press("ArrowDown"); await expect(file).toBeFocused();
  await page.keyboard.press("ArrowLeft"); await expect(stack).toBeFocused();
  await page.keyboard.press("ArrowLeft"); await expect(stack).toHaveAttribute("aria-expanded", "false");
  const search = picker.getByRole("searchbox");
  await search.fill("files");
  await expect(stack).toHaveAttribute("aria-expanded", "true");
  await expect(file).toBeVisible();
  await stack.click(); await expect(stack).toHaveAttribute("aria-expanded", "false");
  await stack.click(); await expect(file).toBeVisible();
  await search.fill(""); await expect(stack).toHaveAttribute("aria-expanded", "false");
  await stack.click();
  await assertAccessible(page);
  await panel.screenshot({ path: info.outputPath("permission-resource-tree.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("permission search excludes unrelated map resources and configuration inputs keep their own editor", async ({ page, studio }) => {
  install(studio);
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const summary = (title: string) => panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: new RegExp(`^${title}`) });
  await summary("Permissions").click(); await summary("Resource permissions").click();
  await panel.getByRole("button", { name: "Add access", exact: true }).click();
  const search = panel.getByRole("searchbox", { name: "Search configured resources", exact: true });
  await expect(panel.getByRole("button", { name: "region · Input parameter", exact: true })).toHaveCount(0);
  await search.fill("region");
  await expect(panel.getByRole("button", { name: "region · Input parameter", exact: true })).toHaveCount(0);
  await search.fill("fixture-1");
  await expect(panel.getByRole("button", { name: /AWS Lambda · Invoke permission/ }).first()).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Add access", exact: true })).toBeFocused();
  await summary("Configuration and inputs").click();
  await panel.getByRole("button", { name: "Add input", exact: true }).click();
  await panel.getByRole("button", { name: "region · Input parameter", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Environment variable", exact: true })).toHaveValue("APP_REGION");
  await expect(panel.getByRole("checkbox", { name: "Full access", exact: true })).toHaveCount(0);
  await assertAccessible(page);
});

test("public stack fields open the same permission editor with managed HTTPS", async ({ page, studio }) => {
  install(studio);
  Object.assign(studio.response.snapshot.source.permissionCapabilities![0]!, { requireHttps: true });
  await studio.goto("/?select=resource%3Afixture0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-slot=stack-members] > details > summary").click();
  await panel.getByRole("button", { name: "files", exact: true }).click();
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Access to this resource/ }).click();
  await panel.getByRole("button", { name: "Grant access", exact: true }).click();
  await panel.getByRole("searchbox", { name: "Search workloads", exact: true }).fill("fixture-0");
  await panel.getByRole("button", { name: /Fixture handler 0 ·/ }).click();
  const editor = panel.getByRole("group", { name: /Access to .*files/ });
  await editor.getByRole("checkbox", { name: "Read objects", exact: true }).check();
  await editor.locator("summary").filter({ hasText: /^Limit access/ }).click();
  await expect(editor.getByRole("switch", { name: "Require HTTPS", exact: true })).toBeChecked();
  await expect(editor.getByRole("switch", { name: "Require HTTPS", exact: true })).toBeDisabled();
  await expect(editor).toContainText("Required by the bucket’s configuration.");
  await expect(editor.getByRole("button", { name: "Stage access", exact: true })).toBeEnabled();
  await assertAccessible(page);
});

test("manual IAM edits preserve resource references, suffixes, effects and conditions", async ({ page, studio }) => {
  install(studio);
  Object.assign(studio.response.snapshot.source, { permissionCapabilities: [...studio.response.snapshot.source.permissionCapabilities!, {
    resource: "framework-stack:Replay.bucket", stack: "framework-stack:Replay", category: "resource", canonicalTypes: ["aws-s3:Bucket"], attributes: ["bucketArn"],
  }] });
  Object.assign(studio.response.snapshot.source, { policyRules: [{ id: "literal-policy", consumers: ["lambda:fixture-0"], writable: true, shared: false, location, statement: { actions: ["s3:GetObject"], resources: [{ kind: "literal", value: "*" }] } }] });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  const rule = panel.locator("[data-slot=policy-rule]"); await rule.locator(":scope > summary").click();
  await rule.getByRole("button", { name: "Edit policy", exact: true }).click();
  const editor = rule.getByRole("group", { name: "IAM policy editor", exact: true });
  await expect(editor.locator('option[value="framework-stack:Replay.bucket.bucketArn"]')).toHaveCount(0);
  await editor.getByRole("combobox", { name: "Effect", exact: true }).selectOption("Deny");
  await editor.getByRole("combobox", { name: "Policy resource 1", exact: true }).selectOption(`${destination}.bucketArn`);
  await editor.getByRole("textbox", { name: "Policy suffix 1", exact: true }).fill("/private/*");
  await editor.locator("summary").filter({ hasText: "Conditions (advanced)" }).click();
  await editor.getByRole("textbox", { name: "IAM condition JSON", exact: true }).fill('{"Bool":{"aws:SecureTransport":"false"}}');
  await assertAccessible(page);
  await editor.getByRole("button", { name: "Stage policy changes", exact: true }).click();
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(item => item.path === "/api/edits/batch/plan")!.body as { edits: DraftEdit[] };
  expect(request.edits[0]).toEqual({ kind: "iamPolicy", target: "lambda:fixture-0", operation: "update", rule: "literal-policy", statement: { actions: ["s3:GetObject"], effect: "Deny", resources: [{ kind: "catalog", resource: destination, attribute: "bucketArn", suffix: "/private/*" }], conditions: { Bool: { "aws:SecureTransport": "false" } } } });
});

test("native grants edit exact arguments and shared IAM declares all affected consumers", async ({ page, studio }) => {
  install(studio);
  Object.assign(studio.response.snapshot.source, { policyRules: [{ id: "shared-policy", consumers: ["lambda:fixture-0", "lambda:fixture-1"], writable: true, shared: true, location, statement: { actions: ["cognito-idp:ListUsers"], resources: [{ kind: "literal", value: "*" }] } }] });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  const shared = panel.locator("[data-slot=policy-rule]"); await shared.locator(":scope > summary").click();
  await expect(shared.getByRole("button", { name: "Edit policy for all consumers", exact: true })).toBeEnabled();
  await expect(shared.getByRole("button", { name: "Add workload-specific rule", exact: true })).toBeEnabled();
  await shared.getByRole("button", { name: "Edit policy for all consumers", exact: true }).click();
  await expect(shared).toContainText("used by 2 workloads");
  await shared.getByRole("button", { name: "Cancel", exact: true }).click();
  const native = panel.locator("[data-slot=access-summary]").filter({ hasText: "Read, write and delete bucket objects" });
  await native.locator(":scope > summary").click();
  await native.getByRole("button", { name: "Edit native grant", exact: true }).click();
  await native.getByRole("textbox", { name: "Native grant arguments", exact: true }).fill('["uploads/*"]');
  await native.getByRole("button", { name: "Stage grant changes", exact: true }).click();
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(item => item.path === "/api/edits/batch/plan")!.body as { edits: DraftEdit[] };
  expect(request.edits[0]).toMatchObject({ connection: "grant", grant: "grantReadWrite", grantArguments: ["uploads/*"], previousGrant: { method: "grantReadWrite", arguments: [] } });
});

test("framework Lambda targets stage an explicit IAM invoke rule", async ({ page, studio }) => {
  install(studio);
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  await panel.getByRole("button", { name: "Add access", exact: true }).click();
  await panel.getByRole("searchbox", { name: "Search configured resources", exact: true }).fill("fixture-1");
  await panel.getByRole("button", { name: "Fixture handler 1 · AWS Lambda · Invoke permission", exact: true }).click();
  const editor = panel.getByRole("group", { name: "IAM policy editor", exact: true });
  await expect(editor.getByRole("textbox", { name: "IAM actions", exact: true })).toHaveValue("lambda:InvokeFunction");
  await editor.getByRole("button", { name: "Stage policy", exact: true }).click();
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(item => item.path === "/api/edits/batch/plan")!.body as { edits: DraftEdit[] };
  expect(request.edits[0]).toMatchObject({ kind: "iamPolicy", operation: "add", statement: { actions: ["lambda:InvokeFunction"], resources: [{ kind: "target", target: "lambda:fixture-1" }] } });
});

test("public native managed policies attach through the resource picker", async ({ page, studio }) => {
  install(studio);
  const policy = "resource:fixture0.readerPolicy";
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, { resources: [...model.resources, { id: policy, path: ["fixture0", "readerPolicy"], kind: "member", nativeKind: "resource", parent: "resource:fixture0", absent: false, typeText: "iam.IManagedPolicy", memberSource: "class" }] });
  Object.assign(studio.response.snapshot.source, { permissionCapabilities: [...studio.response.snapshot.source.permissionCapabilities!, { resource: policy, stack: "resource:fixture0", category: "policy", canonicalTypes: ["aws-iam:IManagedPolicy"], attributes: ["managedPolicyArn"], grants: [], location }] });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  await panel.getByRole("button", { name: "Add access", exact: true }).click();
  await panel.getByRole("searchbox", { name: "Search configured resources", exact: true }).fill("readerPolicy");
  await panel.getByRole("button", { name: /readerPolicy · iam.IManagedPolicy/ }).click();
  await expect(panel).toContainText("Attach managed policy");
  await panel.getByRole("button", { name: "Stage access", exact: true }).click();
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(item => item.path === "/api/edits/batch/plan")!.body as { edits: DraftEdit[] };
  expect(request.edits[0]).toMatchObject({ connection: "managedPolicy", destination: policy, enabled: true });
});

test("a discovered grant on another service keeps its native semantics", async ({ page, studio }) => {
  install(studio);
  Object.assign(studio.response.snapshot.source.permissionCapabilities![0]!, { canonicalTypes: ["aws-kinesis:IStream"], grants: [{ method: "grantReadWrite", parameters: [] }] });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  const rule = panel.locator("[data-slot=resource-permissions] [data-slot=access-summary]");
  await rule.locator(":scope > summary").click();
  await expect(rule.getByRole("button", { name: "Edit native grant", exact: true })).toBeVisible();
  await expect(rule.getByRole("button", { name: "Edit access", exact: true })).toHaveCount(0);
  await expect(rule).not.toContainText("includes deletion");
});

test("undoing one policy removal preserves another staged rule", async ({ page, studio }) => {
  install(studio);
  Object.assign(studio.response.snapshot.source, { policyRules: ["first", "second"].map(id => ({ id, consumers: ["lambda:fixture-0"], writable: true, shared: false, location, statement: { actions: ["cognito-idp:ListUsers"], resources: [{ kind: "literal", value: "*" }] } })) });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  for (const row of await panel.locator("[data-slot=policy-rule]").all()) {
    await row.locator(":scope > summary").click();
    await row.getByRole("button", { name: "Remove policy", exact: true }).click();
  }
  await panel.locator("[data-slot=policy-rule]").first().getByRole("button", { name: "Undo policy removal", exact: true }).click();
  await expect(panel.locator("[data-slot=policy-rule]").first().getByRole("button", { name: "Edit policy", exact: true })).toBeEnabled();
  await expect(panel.locator("[data-slot=policy-rule]").nth(1)).toContainText("Removal staged");
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(item => item.path === "/api/edits/batch/plan")!.body as { edits: DraftEdit[] };
  expect(request.edits).toEqual([{ kind: "iamPolicy", target: "lambda:fixture-0", operation: "remove", rule: "second" }]);
});

test("Lambda Add caller uses the same explicit IAM editor and shows the incoming draft", async ({ page, studio }) => {
  install(studio);
  await studio.goto("/?select=lambda%3Afixture-1");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  const incoming = panel.locator("[data-slot=incoming-access]");
  await incoming.locator(":scope > details > summary").click();
  await incoming.getByRole("button", { name: "Add caller", exact: true }).click();
  await incoming.getByRole("searchbox", { name: "Search workloads", exact: true }).fill("fixture-0");
  await incoming.getByRole("button", { name: /Fixture handler 0 · AWS Lambda/ }).click();
  await incoming.getByRole("group", { name: "IAM policy editor", exact: true }).getByRole("button", { name: "Stage policy", exact: true }).click();
  await expect(incoming).toContainText("Addition staged");
  await expect(incoming.locator(":scope > details > summary")).toContainText("Modified");
  await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled();
  const request = studio.requests.find(item => item.path === "/api/edits/batch/plan")!.body as { edits: DraftEdit[] };
  expect(request.edits[0]).toMatchObject({ kind: "iamPolicy", target: "lambda:fixture-0", statement: { actions: ["lambda:InvokeFunction"], resources: [{ kind: "target", target: "lambda:fixture-1" }] } });
});

test("deployment-readiness differences keep one declared permission with environment-labelled errors", async ({ page, studio }) => {
  install(studio);
  const dev = studio.response.snapshot.models.dev;
  Object.assign(dev, { edges: dev.edges.map(edge => edge.id === "legacy-read" ? { ...edge, readinessIssues: [{ code: "resource-unavailable", severity: "error", entity: "lambda:fixture-0", related: [destination], message: "The destination is unavailable in this AWS lane.", blocksDeployment: true }] } : edge) });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  const rules = panel.locator("[data-slot=resource-permissions] [data-slot=access-summary]");
  await expect(rules).toHaveCount(1);
  await rules.locator(":scope > summary").click();
  await expect(rules).toContainText("Development: The destination is unavailable");
  await expect(rules.getByRole("button", { name: "Edit access", exact: true })).toBeEnabled();
});

test("managed queue triggers disclose overlapping receive and delete access without inferring table item access", async ({ page, studio }) => {
  install(studio);
  const queue = "resource:fixture0.jobs", table = "resource:fixture0.documents";
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, withConnectionAuthorizations({ ...model,
    resources: [...model.resources,
      { id: queue, path: ["fixture0", "jobs"], kind: "member", nativeKind: "resource", parent: "resource:fixture0", absent: false, typeText: "sqs.IQueue", memberSource: "class" },
      { id: table, path: ["fixture0", "documents"], kind: "member", nativeKind: "resource", parent: "resource:fixture0", absent: false, typeText: "dynamodb.ITable", memberSource: "class" },
    ], edges: [...model.edges,
      { id: "queue-access", from: "lambda:fixture-0", to: queue, relation: "grant", provenance: "declared", label: "Receive messages", permissionContext: { kind: "resourceAccess", actions: ["receive"] } },
      { id: "queue-trigger", from: queue, to: "lambda:fixture-0", relation: "trigger", provenance: "declared", label: "Queue trigger", permissionContext: { kind: "trigger", adapter: "sqs" } },
      { id: "table-access", from: "lambda:fixture-0", to: table, relation: "grant", provenance: "declared", label: "Read items", permissionContext: { kind: "resourceAccess", actions: ["read"] } },
      { id: "table-trigger", from: table, to: "lambda:fixture-0", relation: "trigger", provenance: "declared", label: "Table stream", permissionContext: { kind: "trigger", adapter: "dynamodb" } },
    ],
  }));
  Object.assign(studio.response.snapshot.source, { permissionCapabilities: [...studio.response.snapshot.source.permissionCapabilities!,
    { resource: queue, stack: "resource:fixture0", category: "resource", canonicalTypes: ["aws-sqs:IQueue"], location },
    { resource: table, stack: "resource:fixture0", category: "resource", canonicalTypes: ["aws-dynamodb:ITable"], location },
  ] });
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  await panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Permissions/ }).click();
  await panel.locator("[data-slot=resource-permissions] > details > summary").click();
  const queueRule = panel.locator("[data-slot=access-summary]").filter({ hasText: "Receive messages" });
  await queueRule.locator(":scope > summary").click();
  await expect(queueRule).toContainText("Also granted by managed queue trigger");
  await queueRule.getByRole("button", { name: "Edit access", exact: true }).click();
  await expect(queueRule.getByRole("checkbox", { name: "Delete messages", exact: true })).not.toBeChecked();
  const tableRule = panel.locator("[data-slot=access-summary]").filter({ hasText: "Read items" });
  await tableRule.locator(":scope > summary").click();
  await expect(tableRule.locator("[data-slot=permission-overlap]")).toHaveCount(0);
});
