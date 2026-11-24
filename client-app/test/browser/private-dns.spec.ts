import { test, expect, assertAccessible } from "./support/test";
import type { StudioFixture } from "./support/test";
import type { PrivateZoneModel } from "../../shared/private-dns";

function topology(studio: StudioFixture, zones: readonly PrivateZoneModel[] = []) {
  for (const model of Object.values(studio.response.snapshot.models)) {
    Object.assign(model, {
      networks: ["application", "secondary"].map((id, n) => ({ id, name: id, constructId: `${id}NetworkStack`, cidr: `10.${n}.0.0/16`, zones: 2, egressOnlyInternetGateway: true, natGateway: false, gatewayEndpoints: ["s3", "dynamodb"], interfaceEndpoints: [], builtInProd: true, monthlyCost: { natGateway: 0, interfaceEndpoints: 0 }, subnets: ["public", "private", "isolated"].map(name => ({ name, egress: { ipv4: name === "public", ipv6: name !== "isolated" } })) })),
      privateHostedZones: [...zones],
      privateDnsEndpoints: [{ kind: "ecs-internal-alb", service: "example-service", title: "Orders", vpcId: "application", productionEnabled: true, gatewayAuth: false }],
    });
    Object.assign(model.targets[0]!, { placement: { kind: "vpc", networkId: "application", subnet: "private", reason: "Fixture VPC", egress: { ipv4: false, ipv6: true } } });
  }
}
const zone: PrivateZoneModel = { id: "internal", name: "internal.parity.test", enabled: true, constructId: "InternalPrivateHostedZoneStack", vpcIds: ["application"], records: [], localStatus: "unsupported", deploymentProblems: [] };

for (const width of [1440, 390]) test(`VPC to Domains private zone creation reviews the same declaration at ${width}px`, async ({ page, studio }, testInfo) => {
  topology(studio);
  await page.setViewportSize({ width, height: 1000 });
  studio.reply("POST", "/api/edits/batch/plan", async route => {
    await route.fulfill({ json: { planId: "private-zone-plan", ok: true, summaries: ["Create private hosted zone internal"], changes: [{ file: "framework-config/private-dns/internal.ts", operation: "create", diff: { unified: "+definePrivateHostedZone", lines: [{ kind: "add", text: "export const internalPrivateZone = definePrivateHostedZone({...});" }] } }], preflight: { dev: { mode: "dev", ok: true, diagnostics: [] }, prod: { mode: "prod", ok: true, diagnostics: [] } }, impact: ["Source-only. Local private DNS remains unsupported."] } });
  });
  await studio.goto("/?select=island%3Avpc%3Aapplication");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("link", { name: "Create private hosted zone", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Private zone DNS name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Private zone DNS name", exact: true }).fill("internal.parity.test");
  await expect(page.getByRole("checkbox", { name: "Associate private zone with VPC application", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Associate private zone with VPC secondary", exact: true }).check();
  await page.getByRole("button", { name: "Add alias record", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Record 1 name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Record 1 name", exact: true }).fill("api");
  const enabled = page.getByRole("switch", { name: "Include record 1 in AWS deployment", exact: true });
  await enabled.focus(); await enabled.press("Space");
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await page.getByRole("checkbox", { name: "Record 1 allow lambda:fixture-0", exact: true }).check();
  await expect(page.getByText("http://api.internal.parity.test/", { exact: true })).toBeVisible();
  await expect(page.getByText(/Local private DNS execution is unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Review Changes", exact: true }).click();
  const review = page.locator("dialog[open]");
  await expect(review.getByText("Create private hosted zone internal", { exact: true })).toBeVisible();
  const request = studio.requests.find(request => request.path === "/api/edits/batch/plan")!.body as { edits: { kind: string; settings: { vpcIds: string[]; records: { allowFrom: string[] }[] } }[] };
  expect(request.edits[0]!.kind).toBe("privateZone");
  expect(request.edits[0]!.settings.vpcIds).toEqual(["application", "secondary"]);
  expect(request.edits[0]!.settings.records[0]!.allowFrom).toEqual(["lambda:fixture-0"]);
  expect(JSON.stringify(request)).not.toMatch(/localhost|host\.docker|127\.0\.0\.1/);
  await assertAccessible(page);
  await testInfo.attach(`private-zone-review-${width}`, { body: await page.screenshot(), contentType: "image/png" });
});

test("associate an existing private zone through a VPC inspector without granting connectivity", async ({ page, studio }) => {
  topology(studio, [zone]);
  await studio.goto("/?select=island%3Avpc%3Asecondary");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("combobox", { name: "Existing private zone", exact: true }).selectOption("internal");
  await inspector.getByRole("button", { name: "Associate private zone", exact: true }).click();
  await expect(inspector.getByText("Private DNS changes are pending source review.")).toBeVisible();
  await inspector.getByRole("button", { name: "Review Changes", exact: true }).click();
  const body = studio.requests.find(request => request.path === "/api/edits/batch/plan")!.body as { edits: { settings: { vpcIds: string[]; records: unknown[] } }[] };
  expect(body.edits[0]!.settings.vpcIds).toEqual(["application", "secondary"]);
  expect(body.edits[0]!.settings.records).toEqual([]);
});

test("private-zone empty, invalid and authorizer-protected states remain explicit", async ({ page, studio }) => {
  topology(studio);
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model.privateDnsEndpoints![0]!, { gatewayAuth: true });
  await studio.goto("/domains");
  await expect(page.getByText("No private hosted zones declared.")).toBeVisible();
  await page.getByRole("button", { name: "Create private hosted zone", exact: true }).click();
  await page.getByRole("textbox", { name: "Private zone DNS name", exact: true }).fill("https://invalid.test");
  await expect(page.getByRole("button", { name: "Review Changes", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Private zone DNS name", exact: true }).fill("internal.parity.test");
  await page.getByRole("button", { name: "Add alias record", exact: true }).click();
  await page.getByRole("textbox", { name: "Record 1 name", exact: true }).fill("api");
  await expect(page.getByRole("checkbox", { name: "Record 1 allow lambda:fixture-0", exact: true })).toBeDisabled();
  await expect(page.getByText(/would bypass its authorizer/)).toBeVisible();
  await page.getByRole("button", { name: "Remove record 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add alias record", exact: true })).toBeFocused();
  await assertAccessible(page);
  expect(studio.requests.filter(request => request.method !== "GET")).toEqual([]);
});
