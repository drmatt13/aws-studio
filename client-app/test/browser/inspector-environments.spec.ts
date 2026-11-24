import { test, expect, assertAccessible } from "./support/test";

test("moving back and forth between environment pills switches the tooltip immediately", async ({ page, studio }) => {
  await studio.goto("/?select=lambda%3Afixture-0");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const dev = inspector.locator("[data-slot=inspector-kind] [data-environment=dev]");
  const prod = inspector.locator("[data-slot=inspector-kind] [data-environment=prod]");
  for (let pass = 0; pass < 3; pass++) {
    for (const [pill, environment] of [[dev, "Dev"], [prod, "Prod"]] as const) {
      await pill.hover();
      await expect(page.getByRole("tooltip")).toHaveCount(1);
      await expect(page.getByRole("tooltip").locator("strong")).toHaveText(environment);
      await expect(page.getByRole("tooltip")).not.toContainText("Enabled");
    }
  }
  await dev.click();
  await expect(page.getByRole("dialog", { name: /^Development/ })).toBeVisible();
  await prod.hover();
  await expect(page.getByRole("tooltip").locator("strong")).toHaveText("Prod");
  await dev.hover();
  await expect(page.getByRole("tooltip").locator("strong")).toHaveText("Dev");
  expect(studio.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

test("header pills explain execution and Settings preserves reviewed deployment drafts", async ({ page, studio }) => {
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model, { deployChoices: { http: {
      both: { local: true, cloud: true, dev: true, prod: true },
      "local-only": { local: true, cloud: false, dev: false, prod: false },
      "cloud-only": { local: false, cloud: true, dev: false, prod: true },
      none: { local: false, cloud: false, dev: false, prod: false },
    } } });
  }
  Object.assign(studio.response.snapshot.source.editability["lambda:fixture-0"]!, { deploy: { kind: "literal", text: '"both"' } });
  await studio.goto("/?select=lambda%3Afixture-0");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const dev = inspector.locator("[data-slot=inspector-kind] [data-environment=dev]");
  const prod = inspector.locator("[data-slot=inspector-kind] [data-environment=prod]");
  await expect(inspector.getByRole("heading", { name: "Deployment", exact: true })).toHaveCount(0);
  await dev.hover();
  await expect(page.getByRole("tooltip").locator("strong")).toHaveText("Dev");
  await expect(page.getByRole("tooltip")).toContainText("Your machine + AWS Lambda · outside the VPC");
  await page.getByRole("tooltip").hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await prod.focus();
  await expect(page.getByRole("tooltip").locator("strong")).toHaveText("Prod");
  await expect(page.getByRole("tooltip")).toContainText("AWS Lambda · outside the VPC");
  await prod.press("Enter");
  const details = page.getByRole("dialog", { name: "Production · AWS Lambda · outside the VPC" });
  await expect(details.getByRole("button", { name: "Close environment details" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(prod).toBeFocused();

  const summary = inspector.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Settings/ });
  await expect(inspector.getByRole("combobox", { name: "Deploy", exact: true })).toBeHidden();
  await summary.press("Enter");
  await inspector.getByRole("combobox", { name: "Deploy", exact: true }).selectOption("none");
  await expect(dev).toHaveAccessibleName("Development · not enabled");
  await expect(prod).toHaveAccessibleName("Production · not enabled");
  await summary.click();
  await expect(summary).toContainText("Modified");
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  expect(JSON.stringify(studio.requests.find(request => request.path === "/api/edits/batch/plan")?.body)).toContain('"kind":"deploy","target":"lambda:fixture-0","value":"none"');
  await page.getByRole("button", { name: "Back to Editing", exact: true }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dev).toHaveAttribute("data-enabled", "true");
  await expect(summary).not.toContainText("Modified");
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});

test("islands count enabled entries and stack details retain owner navigation", async ({ page, studio }) => {
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model.targets[1]!.lanes, { local: false, dev: false, prod: false });
  }
  await studio.goto("/?select=island%3Alambda");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await expect(inspector.getByRole("button", { name: "Development · 3 of 4 entries enabled", exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Production · 3 of 4 entries enabled", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Configure its entries individually");
  await page.keyboard.press("Escape");
  await assertAccessible(page);

  await page.goto("/?select=resource%3Afixture0");
  await inspector.locator("[data-slot=inspector-kind] [data-environment=dev]").hover();
  await expect(page.getByRole("tooltip").locator("strong")).toHaveText("Dev");
  await expect(page.getByRole("tooltip")).toContainText("CloudFormation stack");
  await expect(page.getByRole("tooltip")).not.toContainText("Catalog availability does not deploy a stack");
  await inspector.locator("[data-slot=inspector-kind] [data-environment=dev]").click();
  const details = page.getByRole("dialog");
  await expect(details.getByRole("combobox", { name: "Deploy", exact: true })).toHaveCount(0);
  await details.getByRole("button", { name: "Configure Fixture handler 0", exact: true }).click();
  await expect(inspector.getByRole("heading", { name: "Fixture handler 0", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(studio.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

test("pill details inside a modal retain focus and close independently", async ({ page, studio }) => {
  await studio.goto();
  await page.getByRole("button", { name: /Development AWS profile:/ }).click();
  await page.getByRole("button", { name: "Configure AWS profiles", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "AWS profile configuration", exact: true });
  await modal.getByRole("complementary", { name: "Configured AWS profiles" }).getByRole("button", { name: /^browser / }).click();
  const dev = modal.locator("[data-slot=inspector-kind] [data-environment=dev]");
  await dev.click();
  const details = modal.getByRole("dialog", { name: /^Development/ });
  await expect(details.getByRole("button", { name: "Close environment details" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(modal).toBeVisible();
  await expect(dev).toBeFocused();
  expect(studio.requests.filter(request => /apply$/.test(request.path))).toHaveLength(0);
});

test.describe("touch environment details", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 740 } });
  test("tap details fit the viewport and dismiss without changing configuration", async ({ page, studio }) => {
    for (const model of Object.values(studio.response.snapshot.models)) {
      Object.assign(model.targets[0]!, { role: "event", compute: { ...model.targets[0]!.compute, localReplay: true } });
    }
    await studio.goto("/?select=lambda%3Afixture-0");
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    const dev = inspector.locator("[data-slot=inspector-kind] [data-environment=dev]");
    await dev.tap();
    const details = page.getByRole("dialog");
    await expect(details.locator("strong")).toHaveText("Dev");
    await expect(details).toContainText("Your machine + AWS Lambda · outside the VPC");
    await expect(details).not.toContainText("Local-only execution requires a local caller");
    const bounds = await details.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(12);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(308);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(728);
    expect((await dev.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await assertAccessible(page);
    await page.screenshot({ path: "../output/playwright/inspector-environments/mobile.png" });
    await details.getByRole("button", { name: "Close environment details" }).tap();
    await expect(details).toHaveCount(0);
    await dev.tap();
    await expect(details).toBeVisible();
    await inspector.getByRole("heading", { name: "Fixture handler 0", exact: true }).tap();
    await expect(details).toHaveCount(0);
    expect(studio.requests.filter(request => request.method !== "GET")).toHaveLength(0);
  });
});
