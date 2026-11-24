import { test, expect, assertAccessible } from "./support/test";
import { NOW } from "./support/scenarios";
import type { JobView } from "../../shared/operations";

for (const viewport of [{ width: 1440, height: 900 }, { width: 897, height: 862 }, { width: 390, height: 844 }, { width: 897, height: 480 }])
test(`Activity keeps history and log scrolling inside the tray at ${viewport.width}x${viewport.height}`, async ({ page, studio }) => {
  await page.setViewportSize(viewport);
  const jobs: JobView[] = Array.from({ length: 30 }, (_, index) => ({
    id: `scroll-job-${index}`, kind: "framework-check", title: `Check fixture ${index}`, params: {},
    status: "succeeded", startedAt: new Date(Date.parse(NOW) - index * 60000).toISOString(),
    endedAt: new Date(Date.parse(NOW) - index * 60000).toISOString(), lastSeq: 360,
  }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
  for (const job of jobs) studio.reply("GET", `/api/operations/${job.id}/log`, route => route.fulfill({ json: {
    job, lines: Array.from({ length: 360 }, (_, index) => ({ seq: index + 1, at: NOW, stream: "out",
      text: `${job.title}: Log line ${index + 1}: ${"long stack trace entry ".repeat(12)}` })),
  } }));
  await studio.goto("/");
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = tray.getByRole("button", { name: /^Activity:/ });
  const separator = tray.getByRole("separator", { name: "Resize bottom panel" });
  const log = tray.getByRole("log", { name: "Log", exact: true });
  const history = tray.getByRole("list", { name: "Operations", exact: true });
  const expectNoDocumentScroll = async () => {
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.evaluate(() => window.scrollTo(10000, 10000));
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 0, y: 0 });
  };

  await expectNoDocumentScroll();
  await toggle.click();
  await history.getByRole("button", { name: /^Check fixture 0 / }).click();
  await expect(log).toContainText("Log line 360");
  await expectNoDocumentScroll();
  // Expanding the history and reaching its last row must scroll the list, not the page.
  await tray.getByRole("button", { name: "Show 10 older", exact: true }).click();
  await history.getByRole("button", { name: /^Check fixture 0 / }).focus();
  await page.keyboard.press("End");
  await expect(history.getByRole("button", { name: /^Check fixture 29 / })).toBeFocused();
  await expect(log).toContainText("Check fixture 29: Log line 360");
  await expectNoDocumentScroll();

  await separator.focus();
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "100");
  await expectNoDocumentScroll();
  await page.keyboard.press("End");
  await expect.poll(async () => (await tray.boundingBox())!.y).toBeCloseTo(0, 0);
  await expectNoDocumentScroll();

  for (const wrap of [false, true]) {
    const wrapButton = tray.getByRole("button", { name: "Wrap", exact: true });
    if ((await wrapButton.getAttribute("aria-pressed")) !== String(wrap)) await wrapButton.click();
    await log.hover();
    await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await page.mouse.wheel(0, 240);
    await expect.poll(() => log.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expectNoDocumentScroll();
  }
  await separator.focus();
  await page.keyboard.press("Home");
  await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "GraphQL", exact: true }).click();
  await expectNoDocumentScroll();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectNoDocumentScroll();
  await assertAccessible(page);
});
