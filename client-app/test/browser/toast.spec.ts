import { test, expect, assertAccessible } from "./support/test";
import type { Locator } from "@playwright/test";

const gallery = "http://127.0.0.1:4593/?view=toasts";

/** Toast text wraps, so a range reports the first line that the dismiss button must sit on. */
const measure = (toast: Locator) => toast.evaluate(element => {
  const button = element.querySelector("button")!;
  const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const lines = [...range.getClientRects()], bounds = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  return {
    lineCenter: lines[0]!.top + lines[0]!.height / 2,
    textRight: Math.max(...lines.map(line => line.right)),
    buttonCenter: bounds.top + bounds.height / 2,
    buttonLeft: bounds.left,
    width: bounds.width,
    height: bounds.height,
    border: style.borderTopWidth,
    background: style.backgroundColor,
  };
});

test("the dismiss button is a quiet control on the message's first line", async ({ page, studio }, testInfo) => {
  await page.goto(gallery);
  await studio.settle();
  const toasts = page.locator('[data-ui="toast"]');
  await expect(toasts).toHaveCount(3);
  for (const toast of await toasts.all()) {
    const geometry = await measure(toast);
    expect(Math.abs(geometry.lineCenter - geometry.buttonCenter)).toBeLessThanOrEqual(1);
    expect(geometry.textRight).toBeLessThanOrEqual(geometry.buttonLeft);
    expect(geometry.border).toBe("0px");
    expect(geometry.background).toBe("rgba(0, 0, 0, 0)");
  }
  await page.screenshot({ path: testInfo.outputPath("toasts.png") });
  await assertAccessible(page);
});

test("hovering answers on the inverted surface and dismissing removes one toast", async ({ page, studio }) => {
  await page.goto(gallery);
  await studio.settle();
  const toast = page.locator('[data-ui="toast"]').first();
  const dismiss = toast.getByRole("button", { name: "Dismiss notification" });
  await dismiss.hover();
  expect((await measure(toast)).background).not.toBe("rgba(0, 0, 0, 0)");
  await dismiss.click();
  await expect(page.getByText("Docker startup completed.")).toHaveCount(0);
  await expect(page.locator('[data-ui="toast"]')).toHaveCount(2);
});

test.describe("coarse input", () => {
  test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: { width: 420, height: 900 } });
  test("the dismiss target reaches 44px and stays on the first line", async ({ page, studio }) => {
    await page.goto(gallery);
    await studio.settle();
    expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    for (const toast of await page.locator('[data-ui="toast"]').all()) {
      const geometry = await measure(toast);
      expect(geometry.width).toBeGreaterThanOrEqual(44);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(geometry.lineCenter - geometry.buttonCenter)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
