import type { Page } from "@playwright/test";
import { NOW } from "./support/scenarios";
import { test, expect, assertAccessible, type StudioFixture } from "./support/test";

type Studio = StudioFixture;
const ROUTES = ["/", "/database", "/deploy", "/graphql", "/cognito", "/domains", "/websockets"];
const FILE = "framework-config/tasks/worker-task.ts";
const LOAD_FAILURE = {
  severity: "error", stage: "load",
  message: `Transform failed with 1 error:\n/studio-fixture/${FILE}:12:19: ERROR: Expected identifier but found ","`,
  location: { file: FILE, line: 12, column: 19 },
};
const AGENT_STATUS = { providers: [{ id: "codex", label: "Codex", available: true, detail: "Fixture CLI." }], busy: false };
let revision = 0;
const announce = (studio: Studio, external: readonly string[] = []) => studio.emit("snapshot", { revision: `health-${revision++}`, external });
async function breakConfiguration(studio: Studio, external: readonly string[] = []) {
  for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, { status: "error", stale: true, diagnostics: [LOAD_FAILURE] });
  await announce(studio, external);
}
async function fixConfiguration(studio: Studio, external: readonly string[] = []) {
  for (const model of Object.values(studio.response.snapshot.models)) { Object.assign(model, { status: "ok", diagnostics: [] }); delete (model as { stale?: true }).stale; }
  await announce(studio, external);
}
const interruptWatching = (studio: Studio) => studio.emit("source-watch", { status: "polling", checkedAt: NOW, pollIntervalMs: 5000, problems: [{ path: "framework-config", code: "EMFILE" }] });
const restoreWatching = (studio: Studio) => studio.emit("source-watch", { status: "watching", checkedAt: NOW, pollIntervalMs: 5000, problems: [] });
async function failRefresh(studio: Studio) {
  studio.reply("GET", "/api/snapshot", route => route.fulfill({ status: 500, json: { error: "Studio server stopped responding." } }));
  await announce(studio);
}
const agentReady = (studio: Studio) => {
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: AGENT_STATUS }));
  studio.reply("GET", "/api/agent-lab/models", route => route.fulfill({ json: { models: [] } }));
};
const indicator = (page: Page) => page.getByRole("button", { name: /^Configuration health/ });
const panel = (page: Page) => page.getByRole("complementary", { name: "Configuration health" });
const toasts = (page: Page) => page.locator('[data-ui="toast"]');
/** Every notification that ever renders. Polling for a count would pass by waiting for a bad toast to expire. */
const recordToasts = (page: Page) => page.evaluate(() => {
  const seen = new Set<string>();
  (window as unknown as { __toasts: Set<string> }).__toasts = seen;
  new MutationObserver(() => document.querySelectorAll('[data-ui="toast"]').forEach(toast => seen.add(toast.textContent ?? ""))).observe(document.body, { childList: true, subtree: true, characterData: true });
});
const everShown = (page: Page) => page.evaluate(() => [...(window as unknown as { __toasts: Set<string> }).__toasts]);
const expectSeverity = (page: Page, severity: string) => expect(indicator(page)).toHaveAttribute("data-severity", severity);
const expectHealthy = (page: Page) => expect(indicator(page)).toHaveCount(0);

/** Every positioned element a developer works with. Status text is excluded: it is what changes. */
const landmarks = (page: Page) => page.evaluate(() => {
  const box = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return [x, y, width, height].map(value => Math.round(value * 10) / 10).join(" "); };
  const measured: Record<string, string> = {};
  for (const [name, selector] of Object.entries({
    bar: '[data-ui="bar"]', workspace: '[data-ui="workspace"]', canvas: '[data-ui="canvas"]', source: '[aria-label="Source environment"]',
    views: 'nav[aria-label="Views"]', tray: 'section[aria-label="Activity"]', slot: '[data-ui="health-status"]',
  })) measured[name] = box(document.querySelector(selector)!);
  document.querySelectorAll('nav[aria-label="Views"] a').forEach(link => { measured[`link ${link.textContent}`] = box(link); });
  document.querySelectorAll('[data-ui="canvas"] > *, [data-ui="canvas"] > * > *').forEach((element, at) => { measured[`content ${at}`] = box(element); });
  document.querySelectorAll('[data-ui~="landscape-bottom"] button').forEach((button, at) => { measured[`dock ${at}`] = box(button); });
  const canvas = document.querySelector('[data-ui="canvas"]')!;
  measured.scroll = `${canvas.scrollHeight} ${canvas.clientHeight} ${canvas.scrollWidth} ${canvas.clientWidth}`;
  return measured;
});
/**
 * Records what moved. The indicator and toasts are meant to change. The map's dock is left out because the
 * Local runtime label flips to "Checking deployment…" on every snapshot, healthy or not; `landmarks` still
 * holds the dock's settled position to account.
 */
async function observeShifts(page: Page) {
  await page.evaluate(() => {
    const moved: string[] = [];
    (window as unknown as { __moved: string[] }).__moved = moved;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as (PerformanceEntry & { sources?: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] })[])
        for (const { node, previousRect: from, currentRect: to } of entry.sources ?? [])
          if (node instanceof Element && !node.closest('[data-ui="toasts"], [data-ui="health-status"], [data-ui~="landscape-bottom"]')) moved.push(`${node.nodeName} ${node.closest("[data-ui]")?.getAttribute("data-ui") ?? ""} "${node.textContent?.slice(0, 24) ?? ""}" ${from.x},${from.y},${from.width} to ${to.x},${to.y},${to.width}`);
    }).observe({ type: "layout-shift", buffered: false });
  });
}
const moved = (page: Page) => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return (window as unknown as { __moved: string[] }).__moved;
});

test.describe("the workspace holds still", () => {
  test.skip(({ colorScheme }) => colorScheme !== "dark", "Geometry does not depend on the theme.");
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 760, height: 900 }, { width: 390, height: 844 }])
    for (const route of ROUTES)
      test(`${route} at ${viewport.width}x${viewport.height} keeps every element through each condition`, async ({ page, studio }) => {
        await page.setViewportSize(viewport);
        await studio.goto(route);
        const before = await landmarks(page);
        await observeShifts(page);

        await breakConfiguration(studio);
        await expectSeverity(page, "error");
        await studio.settle();
        expect(await landmarks(page), "a load failure").toEqual(before);

        await interruptWatching(studio);
        await expect(indicator(page)).toHaveAccessibleName(/1 more condition/);
        expect(await landmarks(page), "a second condition").toEqual(before);

        await fixConfiguration(studio);
        await expectSeverity(page, "warning");
        await studio.settle();
        expect(await landmarks(page), "a watcher warning alone").toEqual(before);

        await restoreWatching(studio);
        await expectHealthy(page);
        expect(await landmarks(page), "recovery").toEqual(before);
        expect(await moved(page), "the browser's layout-shift entries agree").toEqual([]);
      });

  test("a failed refresh moves nothing", async ({ page, studio }) => {
    await studio.goto("/");
    const before = await landmarks(page);
    await failRefresh(studio);
    await expectSeverity(page, "error");
    await studio.settle();
    expect(await landmarks(page)).toEqual(before);
  });

  test("the source hold note takes free space and never narrows navigation", async ({ page, studio }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    studio.reply("GET", "/api/snapshot", route => route.fulfill({ json: { ...studio.response, sourcePublication: { status: "busy", epoch: "fixture" } } }));
    const views = page.getByRole("navigation", { name: "Views" });
    await studio.goto("/");
    const width = await views.evaluate(element => [element.clientWidth, element.scrollWidth]);
    expect(width[0], "every view stays visible").toBe(width[1]);
  });
});

test("visual record", async ({ page, studio, colorScheme }, info) => {
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${colorScheme}-${name}.png`) });
  await page.setViewportSize({ width: 1512, height: 860 });
  await studio.goto("/");
  await breakConfiguration(studio);
  await expect(toasts(page)).toHaveCount(1);
  await shot("failure-toast");
  await indicator(page).click();
  await expect(panel(page)).toBeVisible();
  await interruptWatching(studio);
  await expect(panel(page).locator('[data-condition="source-watch"]')).toBeVisible();
  await shot("panel");
  await page.keyboard.press("Escape");
  await fixConfiguration(studio);
  await expect(toasts(page).filter({ hasText: "Editing is back" })).toHaveCount(1);
  await shot("recovered");
  await page.setViewportSize({ width: 390, height: 844 });
  await indicator(page).click();
  await expect(panel(page)).toBeVisible();
  await shot("phone-panel");
});

test.describe("the indicator", () => {
  test("is absent when healthy and names the failing file when wide enough", async ({ page, studio }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await studio.goto("/");
    await expectHealthy(page);
    await expect(page.locator('[data-ui="bar"]')).not.toContainText(/valid|health/i);
    await breakConfiguration(studio);
    await expect(indicator(page)).toHaveText(/worker-task\.ts:12/);
    await expect(indicator(page)).toHaveText(/Last loaded/);
    await expect(indicator(page)).toHaveAccessibleName(/worker-task\.ts line 12.*Editing is paused/);
    await assertAccessible(page);
  });

  test("keeps severity readable without colour by changing its shape", async ({ page, studio }) => {
    await studio.goto("/");
    const glyph = () => page.locator('[data-ui="health-status"] svg').getAttribute("class");
    await interruptWatching(studio);
    await expectSeverity(page, "warning");
    const warning = await glyph();
    await breakConfiguration(studio);
    await expectSeverity(page, "error");
    expect(await glyph()).not.toBe(warning);
  });

  test("keeps its mark in one place as the condition and its text change", async ({ page, studio }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await studio.goto("/");
    const mark = page.locator('[data-ui="health-status"] svg');
    await interruptWatching(studio);
    await expectSeverity(page, "warning");
    const warning = await mark.boundingBox();
    await breakConfiguration(studio);
    await expectSeverity(page, "error");
    expect(await mark.boundingBox()).toEqual(warning);
  });

  test("reports a failure in the mode that is not being viewed", async ({ page, studio }) => {
    await studio.goto("/");
    Object.assign(studio.response.snapshot.models.prod, { status: "error", stale: true, diagnostics: [LOAD_FAILURE] });
    await announce(studio);
    await expectSeverity(page, "error");
    await indicator(page).click();
    await expect(panel(page)).toContainText("Production only");
  });

  test("stays reachable and a real touch target on a phone", async ({ page, studio }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await studio.goto("/");
    await breakConfiguration(studio);
    await expect(indicator(page)).toBeInViewport();
    await expect(indicator(page)).toHaveText("", { useInnerText: true });
    const size = await indicator(page).boundingBox();
    expect(size!.width).toBeGreaterThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test.describe("the health panel", () => {
  test("states the error, its location, and what still works", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await indicator(page).click();
    const details = panel(page);
    await expect(details.getByRole("heading", { name: "Configuration doesn’t load" })).toBeVisible();
    await expect(details).toContainText(`${FILE}:12:19`);
    await expect(details).toContainText('Expected identifier but found ","');
    await expect(details).not.toContainText("Transform failed");
    await expect(details).not.toContainText("/studio-fixture");
    await expect(details.getByRole("link", { name: "Open in VS Code" })).toHaveAttribute("href", `vscode://file//studio-fixture/${FILE}:12:19`);
    await expect(details).toContainText("Inspector edits and Add to application");
    await expect(details).toContainText("Activity, Agent, Database, Docker and the local runtime");
    await assertAccessible(page);
  });

  test("offers each condition's own recovery", async ({ page, studio }) => {
    studio.reply("POST", "/api/snapshot/refresh", route => route.fulfill({ json: { revision: "reloaded" } }));
    await studio.goto("/");
    await breakConfiguration(studio);
    await interruptWatching(studio);
    await indicator(page).click();
    const watcher = panel(page).locator('[data-condition="source-watch"]');
    await expect(watcher).toContainText("Checking for changes every 5s.");
    await watcher.getByRole("button", { name: "Reload source" }).click();
    await expect.poll(() => studio.requests.some(request => request.path === "/api/snapshot/refresh")).toBe(true);
  });

  test("retrying a failed refresh recovers in place", async ({ page, studio }) => {
    await studio.goto("/");
    await failRefresh(studio);
    await indicator(page).click();
    studio.reply("GET", "/api/snapshot", route => route.fulfill({ json: studio.response }));
    await panel(page).getByRole("button", { name: "Try again" }).click();
    await expect(panel(page)).toContainText("All source graphs load");
  });

  test("Ask in Conversation prepares the composer and sends nothing", async ({ page, studio }) => {
    agentReady(studio);
    await studio.goto("/");
    await breakConfiguration(studio);
    await indicator(page).click();
    await panel(page).getByRole("button", { name: "Ask in Conversation" }).click();
    const composer = page.locator("#studio-agent-question");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(new RegExp(`${FILE}:12:19`));
    await expect(panel(page)).toHaveCount(0);
    expect(studio.requests.filter(request => request.method === "POST" && /agent/.test(request.path))).toEqual([]);
  });

  test("Ask in Conversation adds to a draft rather than replacing it", async ({ page, studio }) => {
    agentReady(studio);
    await studio.goto("/");
    await page.getByRole("tab", { name: "Agent" }).click();
    await page.locator("#studio-agent-question").fill("My own thoughts");
    await breakConfiguration(studio);
    await indicator(page).click();
    await panel(page).getByRole("button", { name: "Ask in Conversation" }).click();
    await expect(page.locator("#studio-agent-question")).toHaveValue(/^My own thoughts\n\nHelp me fix/);
  });

  test("works from the keyboard and returns focus to the indicator", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await expectSeverity(page, "error");
    await indicator(page).focus();
    await expect(indicator(page)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await expect(indicator(page)).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page).getByRole("button", { name: "Close Configuration health" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(indicator(page)).toBeFocused();
  });

  test("toggles from the indicator", async ({ page, studio }) => {
    await studio.goto("/");
    await interruptWatching(studio);
    await indicator(page).click();
    await expect(panel(page)).toBeVisible();
    await indicator(page).click();
    await expect(panel(page)).toHaveCount(0);
  });

  test("stays clear of the Activity bar", async ({ page, studio }) => {
    await page.setViewportSize({ width: 1280, height: 480 });
    await studio.goto("/");
    await breakConfiguration(studio);
    await indicator(page).click();
    await expect(panel(page)).toBeVisible();
    const drawer = await panel(page).boundingBox(), bar = await page.getByRole("region", { name: "Activity", exact: true }).boundingBox();
    expect(drawer!.y + drawer!.height).toBeLessThanOrEqual(bar!.y);
  });

  test("shows recovery in place while open, then focus lands on the workspace", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await indicator(page).click();
    await fixConfiguration(studio);
    await expect(panel(page)).toContainText("All source graphs load");
    await expect(panel(page).getByRole("heading", { name: "Configuration doesn’t load" })).toHaveCount(0);
    await expectSeverity(page, "healthy");
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expectHealthy(page);
    await expect(page.locator('[data-ui="canvas"]')).toBeFocused();
  });

  test.describe("motion", () => {
    test("opens and closes through a short fade", async ({ page, studio }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await studio.goto("/");
      await interruptWatching(studio);
      await indicator(page).click();
      const element = page.locator('[data-ui="drawer"]');
      await expect(element).toBeVisible();
      const style = await element.evaluate(node => { const computed = getComputedStyle(node); return { property: computed.transitionProperty, duration: Number.parseFloat(computed.transitionDuration), behavior: computed.transitionBehavior }; });
      expect(style.property).toContain("opacity");
      expect(style.behavior).toContain("allow-discrete");
      expect(style.duration).toBeGreaterThan(0);
      expect(style.duration).toBeLessThanOrEqual(0.2);
      const closing = await element.evaluate(node => new Promise<string>(resolve => {
        (document.querySelector('[aria-label="Close Configuration health"]') as HTMLElement).click();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(getComputedStyle(node).display)));
      }));
      expect(closing, "it stays painted while it fades").not.toBe("none");
      await expect(element).toBeHidden();
    });
  });

  test.describe("reduced motion", () => {
    test("changes instantly", async ({ page, studio }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await studio.goto("/");
      await interruptWatching(studio);
      await indicator(page).click();
      const duration = await page.locator('[data-ui="drawer"]').evaluate(node => getComputedStyle(node).transitionDuration);
      expect(Number.parseFloat(duration)).toBe(0);
    });
  });
});

test.describe("notifications", () => {
  test("a failure toasts once and survives repeated snapshots", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    const toast = toasts(page).filter({ hasText: "Configuration doesn’t load: worker-task.ts:12." });
    await expect(toast).toHaveCount(1);
    for (let poll = 0; poll < 4; poll += 1) await announce(studio);
    await interruptWatching(studio);
    await page.waitForTimeout(1500);
    await expect(toast).toHaveCount(1);
    await expect(toasts(page).filter({ hasText: "Configuration doesn’t load" })).toHaveCount(1);
  });

  test("its action opens the details and focus survives the toast leaving", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await toasts(page).getByRole("button", { name: "Show details" }).click();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(indicator(page)).toBeFocused();
  });

  test("recovery replaces the failure notice where it stands, so the two never contradict", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await expect(toasts(page)).toHaveCount(1);
    const place = await toasts(page).evaluate(element => { const { x, bottom } = element.getBoundingClientRect(); return { x, bottom }; });
    await fixConfiguration(studio);
    await expect(toasts(page).filter({ hasText: "Configuration loads again. Editing is back." })).toHaveCount(1);
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).getByRole("button", { name: "Show details" })).toHaveCount(0);
    expect(await toasts(page).evaluate(element => { const { x, bottom } = element.getBoundingClientRect(); return { x, bottom }; })).toEqual(place);
    await expectHealthy(page);
  });

  test("a save that breaks the configuration never claims the view refreshed", async ({ page, studio }) => {
    await studio.goto("/");
    await recordToasts(page);
    await breakConfiguration(studio, [FILE]);
    await expect(toasts(page).filter({ hasText: "Configuration doesn’t load" })).toHaveCount(1);
    expect(await everShown(page)).toEqual([expect.stringContaining("Configuration doesn’t load")]);
  });

  test("saving again while broken stays quiet", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio, [FILE]);
    await expect(toasts(page).filter({ hasText: "Configuration doesn’t load" })).toHaveCount(1);
    await recordToasts(page);
    await announce(studio, [FILE]);
    await page.waitForTimeout(1600);
    expect((await everShown(page)).filter(text => text.includes("changed outside"))).toEqual([]);
  });

  test("the save that fixes it is confirmed once", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio, [FILE]);
    await expect(toasts(page).filter({ hasText: "Configuration doesn’t load" })).toHaveCount(1);
    await recordToasts(page);
    await fixConfiguration(studio, [FILE]);
    await expect(toasts(page).filter({ hasText: "Configuration loads again." })).toHaveCount(1);
    await expect(toasts(page)).toHaveCount(1);
    expect((await everShown(page)).filter(text => text.includes("changed outside"))).toEqual([]);
  });

  test("an ordinary outside save is still reported", async ({ page, studio }) => {
    await studio.goto("/");
    await announce(studio, [FILE]);
    await expect(toasts(page).filter({ hasText: `${FILE} changed outside the studio.` })).toHaveCount(1);
  });

  test("an outside save whose refresh failed never claims the view refreshed", async ({ page, studio }) => {
    await studio.goto("/");
    await recordToasts(page);
    studio.reply("GET", "/api/snapshot", route => route.fulfill({ status: 500, json: { error: "Studio server stopped responding." } }));
    await announce(studio, [FILE]);
    await expectSeverity(page, "error");
    await page.waitForTimeout(1600);
    expect((await everShown(page)).filter(text => text.includes("changed outside"))).toEqual([]);
  });

  test("a failure fixed before it settles never interrupts", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await expectSeverity(page, "error");
    await fixConfiguration(studio);
    await expectHealthy(page);
    await page.waitForTimeout(1600);
    await expect(toasts(page)).toHaveCount(0);
  });

  test("opening Studio on a known problem shows the indicator without a toast", async ({ page, studio }) => {
    for (const model of Object.values(studio.response.snapshot.models)) Object.assign(model, { status: "error", stale: true, diagnostics: [LOAD_FAILURE] });
    await studio.goto("/");
    await expectSeverity(page, "error");
    await page.waitForTimeout(1600);
    await expect(toasts(page)).toHaveCount(0);
  });

  test("announces through one polite live region", async ({ page, studio }) => {
    await studio.goto("/");
    await breakConfiguration(studio);
    await expect(toasts(page)).toHaveCount(1);
    const live = page.locator('[aria-live]').filter({ hasText: "Configuration doesn’t load" });
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(page.getByRole("alert").filter({ hasText: "Configuration doesn’t load" })).toHaveCount(0);
  });

  test.describe("placement", () => {
    test.skip(({ colorScheme }) => colorScheme !== "dark", "Geometry does not depend on the theme.");
    /** Rectangles of persistent controls a notification overlaps. Empty means nothing is covered. */
    const covered = (page: Page) => page.evaluate(() => {
      const visible = (element: Element) => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility === "visible"; };
      const controls = [...document.querySelectorAll('[data-ui="bar"] a, [data-ui="bar"] button, section[aria-label="Activity"] [role="tab"], section[aria-label="Activity"] > div button, [data-ui~="landscape-bottom"] button')].filter(visible);
      const hits: string[] = [];
      for (const toast of [...document.querySelectorAll('[data-ui="toast"]')].filter(visible)) {
        const a = toast.getBoundingClientRect();
        for (const control of controls) {
          const b = control.getBoundingClientRect();
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(control.textContent?.trim() || control.getAttribute("aria-label") || control.nodeName);
        }
      }
      return hits;
    });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 800, height: 600 }, { width: 390, height: 844 }, { width: 390, height: 480 }])
      for (const route of ["/", "/deploy", "/database"]) {
        test(`${route} at ${viewport.width}x${viewport.height} covers no control`, async ({ page, studio }) => {
          await page.setViewportSize(viewport);
          await studio.goto(route);
          await breakConfiguration(studio);
          await expect(toasts(page)).toHaveCount(1);
          expect(await covered(page), "tray closed").toEqual([]);
          await page.keyboard.press("Control+`");
          await expect(page.locator('#studio-activity-drawer[aria-hidden="false"]')).toBeAttached();
          await studio.settle();
          await page.waitForTimeout(320);
          expect(await covered(page), "tray open").toEqual([]);
        });
      }

    test("several notifications never reach the navigation on a short window", async ({ page, studio }) => {
      await page.setViewportSize({ width: 390, height: 480 });
      await studio.goto("/");
      await breakConfiguration(studio);
      await interruptWatching(studio);
      await expect(toasts(page)).toHaveCount(2);
      await failRefresh(studio);
      await expect(toasts(page)).toHaveCount(3);
      await expect(toasts(page).first(), "the oldest gives way rather than showing half a message").toBeHidden();
      await expect(toasts(page).last()).toBeVisible();
      const navigation = await page.locator('[data-ui="bar"]').boundingBox();
      const stack = await page.locator('[data-ui="toasts"]').boundingBox();
      expect(stack!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height);
      expect(await covered(page)).toEqual([]);
    });
  });
});
