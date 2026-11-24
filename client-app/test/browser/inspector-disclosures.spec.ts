import type { ModelResource } from "../../shared/model";
import { withConnectionAuthorizations } from "../../shared/permissions";
import { location } from "./support/scenarios";
import { test, expect, assertAccessible } from "./support/test";

for (const width of [1440, 390, 320]) test(`resource disclosures start closed and preserve keyboard-opened state on Back at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  const stack = "resource:fixture0";
  const member: ModelResource = { id: `${stack}.queue`, kind: "member", nativeKind: "resource", path: ["fixture0", "queue"], parent: stack, typeText: "sqs.Queue", memberSource: "class", absent: false };
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.resources.find(resource => resource.id === stack)!, {
      frameworkStack: true,
      stackOutputs: [{ name: "FixtureQueueArn", envName: "FIXTURE_QUEUE_ARN", symbol: "FixtureStack0.FixtureQueueArn", source: location }],
    });
    Object.assign(model, { resources: [...model.resources, member] });
    Object.assign(model.edges.find(edge => edge.from === "lambda:fixture-0" && edge.to === stack && edge.relation === "grant")!, {
      permissionContext: { kind: "native", method: "grantRead", arguments: [] },
    });
    Object.assign(model, withConnectionAuthorizations(model));
  }
  await studio.goto("/?select=lambda%3Afixture-0");
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const content = panel.locator("[data-slot=inspector-content]");
  const disclosure = (title: string) => {
    const summary = panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: new RegExp(`^${title}`) });
    return { summary, details: summary.locator("..") };
  };
  const permissions = disclosure("Permissions");
  const settings = disclosure("Settings");
  await expect(content.locator("details[open]")).toHaveCount(0);
  await expect(permissions.details).not.toHaveAttribute("open");
  await expect(settings.details).not.toHaveAttribute("open");
  await expect(panel.getByRole("button", { name: "Add access", exact: true })).toBeHidden();
  await expect(panel.getByRole("spinbutton", { name: "Memory in MB", exact: true })).toBeHidden();

  await permissions.summary.focus();
  await page.keyboard.press("Space");
  await expect(permissions.details).toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: "Add access", exact: true })).toBeHidden();
  const resourcePermissions = disclosure("Resource permissions");
  await resourcePermissions.summary.focus();
  await page.keyboard.press("Space");
  await expect(panel.getByRole("button", { name: "Add access", exact: true })).toBeVisible();
  await settings.summary.focus();
  await page.keyboard.press("Enter");
  await expect(settings.details).toHaveAttribute("open", "");
  const memory = panel.getByRole("spinbutton", { name: "Memory in MB", exact: true });
  await expect(memory).toBeVisible();
  await memory.fill("1");
  await settings.summary.click();
  await expect(settings.summary).toContainText("Needs attention");
  await expect(page.getByRole("button", { name: "Review Changes", exact: true })).toBeDisabled();
  await settings.summary.click();
  await memory.fill("512");
  await settings.summary.click();
  await expect(settings.summary).toContainText("Modified");
  await settings.summary.click();
  await memory.fill("256");
  await expect(settings.summary).not.toContainText("Modified");
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const access = permissions.details.locator("[data-slot=access-summary]").first();
  await access.locator(":scope > summary").click();
  await access.getByRole("button", { name: "Inspect resource", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "FixtureStack0", exact: true })).toBeVisible();
  await expect(content.locator("details[open]")).toHaveCount(0);
  const fields = disclosure("Resources");
  await expect(fields.details).not.toHaveAttribute("open");
  await expect(disclosure("Exports").details).not.toHaveAttribute("open");
  const resource = panel.getByRole("button", { name: "queue", exact: true });
  await expect(resource).toBeHidden();
  await expect(fields.details.locator('[data-slot="stack-resource"] img')).toHaveAttribute("src", "/icons/aws/sqs.svg");
  await fields.summary.focus();
  await page.keyboard.press("Space");
  await expect(resource).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(resource).toBeHidden();
  await expect(fields.details).not.toHaveAttribute("open");
  await page.keyboard.press("Enter");
  await resource.click();
  await expect(panel.getByRole("heading", { name: "queue", exact: true })).toBeVisible();
  await expect(content.locator("details[open]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Back to FixtureStack0", exact: true }).click();
  await expect(fields.details).toHaveAttribute("open", "");
  await expect(resource).toBeFocused();
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Back to Fixture handler 0", exact: true }).click();
  await expect(permissions.details).toHaveAttribute("open", "");
  await expect(resourcePermissions.details).toHaveAttribute("open", "");
  await expect(settings.details).toHaveAttribute("open", "");
  await expect(access.getByRole("button", { name: "Inspect resource", exact: true })).toBeFocused();
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});

for (const width of [1440, 390]) test(`stack exports combine fields and CDK outputs at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  const stack = "resource:fixture0";
  const member = (name: string, nativeKind: "value" | "resource"): ModelResource => ({
    id: `${stack}.${name}`, kind: "member", nativeKind, path: ["fixture0", name], parent: stack,
    typeText: nativeKind === "value" ? "string" : "sqs.Queue", memberSource: "class", absent: false,
  });
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.resources.find(resource => resource.id === stack)!, {
      stackOutputs: [
        { name: "PublicUrl", symbol: "publicUrl", envName: "PUBLIC_URL", source: location },
        { name: "LegacyUrl", symbol: "publicUrl", envName: "LEGACY_URL", source: location },
        { name: "QueueArn", symbol: "queue.queueArn", envName: "QUEUE_ARN", source: location },
        { name: "StandaloneOutput", symbol: "computedValue", envName: "COMPUTED_VALUE", source: location },
      ],
    });
    Object.assign(model, { resources: [...model.resources, member("publicUrl", "value"), member("trustedOrigins", "value"), member("queue", "resource")] });
  }
  await studio.goto(`/?select=${encodeURIComponent(stack)}`);
  const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
  const exports = panel.locator('[data-slot="stack-exports"]');
  await expect(exports).toHaveCount(1);
  await expect(exports.locator("details")).not.toHaveAttribute("open");
  await expect(exports.locator('[data-slot="section-count"]')).toHaveText("4");
  await expect(panel.getByText(/Public values|CloudFormation outputs|root \.env exporter/)).toHaveCount(0);
  await exports.locator("summary").click();
  const values = exports.locator('[data-slot="stack-export"]');
  await expect(values).toHaveCount(4);
  const url = values.filter({ has: page.getByRole("button", { name: "publicUrl", exact: true }) });
  await expect(url).toHaveCount(1);
  await expect(url).toContainText("stacks.fixture0.publicUrl");
  await expect(url).toContainText("PUBLIC_URL");
  await expect(url).toContainText("LEGACY_URL");
  await expect(values).toContainText(["stacks.fixture0.publicUrl", "stacks.fixture0.trustedOrigins", "stacks.fixture0.queue.queueArn", "computedValue"]);
  await expect(exports.getByText("stacks.fixture0.computedValue", { exact: true })).toHaveCount(0);
  await url.getByRole("button", { name: "publicUrl", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "publicUrl", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Back to FixtureStack0", exact: true }).click();
  await expect(exports.locator("details")).toHaveAttribute("open", "");
  await expect(url.getByRole("button", { name: "publicUrl", exact: true })).toBeFocused();
  expect(await panel.locator("[data-slot=inspector-content]").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await assertAccessible(page);
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});
