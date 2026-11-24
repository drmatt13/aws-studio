import { test, expect } from "./support/test";

const drawn = () => (window as unknown as { __studioLandscape?: { stats(): { drawn: number } } }).__studioLandscape?.stats().drawn ?? 0;

test("the first map waits for required SVGs, without waiting for unused artwork", async ({ page }) => {
  let releaseLambda!: () => void, releaseUnused!: () => void;
  const lambda = new Promise<void>(resolve => { releaseLambda = resolve; });
  const unused = new Promise<void>(resolve => { releaseUnused = resolve; });
  let lambdaRequested = false, unusedRequested = false;
  await page.route("**/icons/aws/lambda.svg", async route => {
    lambdaRequested = true;
    await lambda;
    await route.continue();
  });
  await page.route("**/icons/aws/agentcore.svg", async route => {
    unusedRequested = true;
    await unused;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("canvas")).toBeVisible();
    await expect.poll(() => lambdaRequested && unusedRequested).toBe(true);
    await page.waitForFunction(() => (window as unknown as { __studioLandscape?: { stats(): { frames: number } } }).__studioLandscape?.stats().frames);
    await expect.poll(() => page.evaluate(drawn)).toBe(0);
    releaseLambda();
    await expect.poll(() => page.evaluate(drawn)).toBeGreaterThan(0);
    await expect(page.locator('link[rel="preload"][href="/icons/aws/lambda.svg"]')).toHaveAttribute("fetchpriority", "high");
  } finally {
    releaseLambda();
    releaseUnused();
  }
  await page.waitForLoadState("load");
});

test("refreshes paint complete maps and route remounts reuse decoded images", async ({ page, studio }) => {
  await page.addInitScript(() => {
    const NativeImage = window.Image;
    const counts: Record<string, number> = {};
    (window as unknown as { __mapImageCounts: typeof counts }).__mapImageCounts = counts;
    window.Image = class extends NativeImage {
      override set src(value: string) { counts[value] = (counts[value] ?? 0) + 1; super.src = value; }
      override get src() { return super.src; }
    };
  });
  const counts = () => (window as unknown as { __mapImageCounts: Record<string, number> }).__mapImageCounts;
  await studio.goto();
  await expect.poll(() => page.evaluate(drawn)).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(() => page.evaluate(drawn)).toBeGreaterThan(0);
  const before = await page.evaluate(counts);
  expect(before["/icons/aws/lambda.svg"]).toBe(1);
  await page.getByRole("link", { name: "GraphQL", exact: true }).click();
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("link", { name: "Map", exact: true }).click();
  await expect.poll(() => page.evaluate(drawn)).toBeGreaterThan(0);
  expect(await page.evaluate(counts)).toEqual(before);
});
