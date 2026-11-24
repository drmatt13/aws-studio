import type { Page } from "@playwright/test";
import { test, expect } from "./support/test";
import { workbench } from "./support/scenarios";

/** Give the shared Note fixture real source ranges so diagram navigation selects its field. */
function navigableWorkbench() {
  const saved = workbench(), schema = saved.validation.schema!;
  return {
    ...saved,
    validation: {
      ...saved.validation,
      schema: {
        ...schema,
        tables: schema.tables.map(table => ({
          ...table,
          source: { ...table.source, start: 0, end: saved.source.length },
          columns: table.columns.map(column => {
            const start = saved.source.indexOf(`  ${column.name} `) + 2;
            return { ...column, source: { ...column.source, start, end: saved.source.indexOf("\n", start) } };
          }),
        })),
      },
    },
  };
}

async function paneGeometry(page: Page) {
  return page.evaluate(() => {
    const selectors = {
      split: '[data-ui="workbench-split"]',
      source: '[data-ui="workbench-source-pane"]',
      diagram: '[data-ui="workbench-diagram-pane"]',
      sourceFooter: '[data-ui="workbench-editor-status"]',
      diagramFooter: '[data-ui="workbench-diagram-caption"]',
    };
    return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return [name, { x, y, width, height }];
    }));
  });
}

interface SchemaFrame {
  readonly loading: boolean;
  readonly gutterGap?: number;
  readonly lineHeight?: number;
}

/** Sample before paint, including the frame before CodeMirror's deferred measure. */
function recordSchemaFrames() {
  const samples: SchemaFrame[] = [];
  Object.assign(window, { __schemaFrames: samples });
  const sample = () => {
    if (location.pathname === "/database/schema") {
      const editor = document.querySelector<HTMLElement>('[data-prisma-editor]');
      const numbers = Array.from(editor?.querySelectorAll(".cm-lineNumbers .cm-gutterElement") ?? []);
      const first = numbers.find(element => element.textContent === "1");
      const second = numbers.find(element => element.textContent === "2");
      samples.push({
        loading: !!document.querySelector('[data-ui="workbench-loading"]'),
        ...(first && second && editor?.getClientRects().length ? {
          gutterGap: second.getBoundingClientRect().top - first.getBoundingClientRect().top,
          lineHeight: parseFloat(getComputedStyle(editor.querySelector(".cm-content")!).lineHeight),
        } : {}),
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

async function schemaFrames(page: Page, clear = false): Promise<SchemaFrame[]> {
  return page.evaluate(clear => {
    const frames = (window as unknown as { __schemaFrames: SchemaFrame[] }).__schemaFrames;
    return clear ? frames.splice(0) : frames;
  }, clear);
}

for (const width of [1440, 375]) {
  test(`schema gutters align on first paint and cached returns skip loading at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(recordSchemaFrames);
    await studio.goto("/database/schema");
    const editor = page.getByRole("textbox", { name: "Prisma schema source" });
    await expect(editor).toContainText("model Note");
    await studio.settle();
    const initial = await schemaFrames(page, true);
    expect(initial.some(frame => frame.gutterGap !== undefined)).toBe(true);
    for (const frame of initial.filter(frame => frame.gutterGap !== undefined)) {
      expect(Math.abs(frame.gutterGap! - frame.lineHeight!)).toBeLessThan(0.5);
    }

    const navigation = page.getByRole("navigation", { name: "Database workspace" });
    await navigation.getByRole("link", { name: "Data retention", exact: true }).click();
    await navigation.getByRole("link", { name: "Schema", exact: true }).click();
    await expect(editor).toBeVisible();
    await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "GraphQL", exact: true }).click();
    await expect(page).toHaveURL(/\/graphql\/schema$/);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    studio.reply("GET", "/api/database/workbench", async route => { await pending; await route.fulfill({ json: workbench() }); });
    const reads = studio.requests.filter(request => request.path === "/api/database/workbench").length;
    try {
      await page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "Database", exact: true }).click();
      await expect(editor).toContainText("model Note");
      await expect.poll(() => studio.requests.filter(request => request.path === "/api/database/workbench").length).toBeGreaterThan(reads);
      await studio.settle();
      const returned = await schemaFrames(page);
      expect(returned.some(frame => frame.gutterGap !== undefined)).toBe(true);
      expect(returned.some(frame => frame.loading)).toBe(false);
      for (const frame of returned.filter(frame => frame.gutterGap !== undefined)) {
        expect(Math.abs(frame.gutterGap! - frame.lineHeight!)).toBeLessThan(0.5);
      }
    } finally { release(); }
    expect(studio.requests.filter(request => /\/(save|install|execute|apply|inspect)$/.test(request.path))).toEqual([]);
  });
}

test("a failed cached-source refresh preserves the editor and retry protects a modified draft", async ({ page, studio }) => {
  await studio.goto("/database/schema");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await expect(editor).toContainText("model Note");
  const views = page.getByRole("navigation", { name: "Views", exact: true });
  await views.getByRole("link", { name: "GraphQL", exact: true }).click();
  studio.reply("GET", "/api/database/workbench", route => route.fulfill({ status: 503, json: { error: "Fixture source refresh unavailable" } }));
  await views.getByRole("link", { name: "Database", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture source refresh unavailable");
  await expect(editor).toContainText("model Note");
  const original = await editor.elementHandle();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// Retained cached draft\n");
  const saved = workbench();
  studio.reply("GET", "/api/database/workbench", route => route.fulfill({ json: { ...saved, revision: "external-source", source: saved.source + "\n// External source edit\n" } }));
  await page.getByRole("button", { name: "Retry loading source", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saved source changed outside this session.");
  await expect(editor).toContainText("Retained cached draft");
  await expect(editor).not.toContainText("External source edit");
  expect(await original!.evaluate(element => element === document.querySelector('[aria-label="Prisma schema source"]'))).toBe(true);
  expect(studio.requests.filter(request => /\/(save|install|execute|apply|inspect)$/.test(request.path))).toEqual([]);
});

test("database keyboard layout resizing and modal focus preserve the same editor", async ({ page, studio }) => {
  await studio.goto("/database");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await expect(editor).toContainText("model Note");
  await expect(page.locator('[data-ui="workbench-split"]')).toHaveAttribute("data-mode", "source");
  const splitLayout = page.getByRole("button", { name: "Split source and diagram", exact: true });
  await splitLayout.click();
  await expect(splitLayout).toBeFocused();
  const splitter = page.getByRole("separator", { name: "Resize source and diagram" });
  const ratio = Number(await splitter.getAttribute("aria-valuenow"));
  await splitter.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", String(ratio + 2));
  await expect(splitter).toBeFocused();
  await page.getByRole("button", { name: "Focus source", exact: true }).click();
  await expect(editor).toBeVisible();
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select table Note" })).toBeVisible();
  const help = page.getByRole("button", { name: "How this works", exact: true });
  await help.click();
  const dialog = page.getByRole("dialog", { name: "How this works" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  await expect(editor).toContainText("model Note");
});

test("schema search resets and the editor keeps its own find shortcut", async ({ page, studio }) => {
  await studio.goto("/database");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Find a table or column" });
  await search.fill("Note");
  await page.getByRole("button", { name: "Clear schema search" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(find).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Alt+f");
  await expect(find).toBeVisible();
  await expect(find).toBeFocused();
  await find.fill("model Note");
  await page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  await expect(editor).toBeFocused();
  expect(studio.requests.filter(request => request.path.endsWith("/save"))).toHaveLength(0);
});

test("native fullscreen preserves the mounted editor and restores the previous layout", async ({ page, studio }) => {
  await studio.goto("/database");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  const originalEditor = await editor.elementHandle();
  await page.getByRole("button", { name: "Fullscreen schema workspace", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(page.getByRole("navigation", { name: "Database workspace", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Focus diagram", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("button", { name: "Select table Note", exact: true })).toBeVisible();
  expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("model Note");
  expect(await originalEditor!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByRole("button", { name: "Fullscreen schema workspace", exact: true })).toBeFocused();
  expect(studio.requests.filter(request => request.path.endsWith("/save"))).toHaveLength(0);
});

test("schema status bars stay aligned through field navigation and a validated modified draft", async ({ page, studio }) => {
  const saved = navigableWorkbench();
  studio.reply("GET", "/api/database/workbench", async route => { await route.fulfill({ json: saved }); });
  studio.reply("POST", "/api/database/workbench/validate", async route => { await route.fulfill({ json: saved.validation }); });
  await studio.goto("/database");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await expect(editor).toContainText("model Note");
  const initial = await paneGeometry(page);
  expect(initial.sourceFooter.height).toBe(32);
  expect(initial.diagramFooter.height).toBe(initial.sourceFooter.height);
  expect(initial.diagramFooter.y).toBe(initial.sourceFooter.y);

  await page.getByRole("button", { name: "Locate Note.title", exact: true }).click();
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("title String");
  expect(await paneGeometry(page)).toEqual(initial);

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// Draft comment for layout verification\n");
  await expect(page.getByText("Modified draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Validate draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Valid Prisma 8" })).toBeVisible();
  await studio.settle();
  expect(await paneGeometry(page)).toEqual(initial);
  await expect(page.locator('[data-ui="workbench-impact"]')).toHaveCount(0);
  await expect(page.getByText("Source changed; storage and execution contracts are unchanged.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Modified draft", { exact: true })).toBeVisible();
  expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
});

test("diagram source selection uses the Studio accent while the editor is focused and unfocused", async ({ page, studio }) => {
  const saved = navigableWorkbench();
  studio.reply("GET", "/api/database/workbench", async route => { await route.fulfill({ json: saved }); });
  await studio.goto("/database");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await page.getByRole("button", { name: "Locate Note.title", exact: true }).click();
  await expect(editor).toBeFocused();
  const selection = page.locator(".cm-selectionBackground").first();
  await expect(selection).toBeVisible();
  const accentSelection = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "color-mix(in srgb, var(--dev) 18%, transparent)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(selection).toHaveCSS("background-color", accentSelection);
  // A mounted editor can retain the upstream theme across React Refresh. Even a
  // later default theme must not wash out selected syntax in that existing view.
  await page.addStyleTag({ content: ".cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #d7d4f0; }" });
  await expect(selection).toHaveCSS("background-color", accentSelection);
  await page.getByRole("searchbox", { name: "Find a table or column" }).focus();
  await expect(editor).not.toBeFocused();
  await expect(selection).toBeVisible();
  await expect(selection).toHaveCSS("background-color", accentSelection);
});

for (const width of [1440, 375]) {
  test(`schema details opens from the keyboard without moving panes and stays bounded at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 900 });
    await studio.goto("/database");
    await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Schema details", exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    const initial = await paneGeometry(page);
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "Schema details", exact: true });
    await expect(details).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await details.evaluate(element => element.matches(":popover-open"))).toBe(true);
    await expect(details.getByRole("button", { name: "Close schema details", exact: true })).toBeFocused();
    expect(await paneGeometry(page)).toEqual(initial);
    const bounds = (await details.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900);
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    expect(await paneGeometry(page)).toEqual(initial);
  });
}

test("database route navigation preserves the Prisma draft and supports direct links and browser history", async ({ page, studio }) => {
  const saved = navigableWorkbench();
  studio.reply("GET", "/api/database/history", route => route.fulfill({ json: { revision: "route-history", sourceHash: saved.revision, observedAt: "2026-10-29T12:00:00Z", migrations: [], snapshots: [], heads: [], refs: [], issues: [] } }));
  studio.reply("GET", "/api/database/application/operations", route => route.fulfill({ json: [] }));
  studio.reply("GET", "/api/database/sql", route => route.fulfill({ json: { directory: "packages/database/sql", commands: [], history: [], targets: [], issues: [] } }));
  await studio.goto("/database");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  const original = await editor.elementHandle();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("// Unsaved route draft\n");
  const navigation = page.getByRole("navigation", { name: "Database workspace" });
  for (const [name, path] of [["History & migrations", "history"], ["Database status", "status"], ["Saved SQL", "sql"], ["Data retention", "retention"]]) {
    await navigation.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/database/" + path + "$"));
    await expect(navigation.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/database\/sql$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/database\/retention$/);
  await navigation.getByRole("link", { name: "Schema", exact: true }).click();
  await expect(editor).toContainText("Unsaved route draft");
  await expect(page.getByText("Modified draft", { exact: true })).toBeVisible();
  expect(await original!.evaluate(element => element === document.querySelector('[aria-label="Prisma schema source"]'))).toBe(true);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Unsaved route draft");
  await navigation.getByRole("link", { name: "History & migrations", exact: true }).click();
  await page.getByRole("button", { name: "Plan migration", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Plan a forward migration" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/database\/schema$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  studio.reply("POST", "/api/database/sql/review", route => route.fulfill({ json: {
    id: "route-query-review", path: "packages/database/sql/inspection/inspect_database.sql", before: null,
    after: 'SELECT current_database() AS database, current_schema() AS schema, current_user AS "user";',
    command: { name: "inspect_database", kind: "inspection", intent: "repeatable", description: "Inspect the current database", parameters: [], sql: 'SELECT current_database() AS database, current_schema() AS schema, current_user AS "user";' },
    expiresAt: "2099-01-01T00:00:00Z",
  } }));
  await navigation.getByRole("link", { name: "Saved SQL", exact: true }).click();
  await page.getByRole("button", { name: "Create query", exact: true }).click();
  await page.getByRole("button", { name: "Review SQL source", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Review saved SQL source" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/database\/history$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\/database\/sql$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const path of ["history", "status", "sql", "retention"]) {
    await page.goto("/database/" + path);
    await page.reload();
    await expect(navigation.locator('[aria-current="page"]')).toHaveAttribute("href", "/database/" + path);
  }
  await page.goto("/database#status");
  await expect(page).toHaveURL(/\/database\/status$/);
  expect(studio.requests.filter(request => /\/(save|install|execute|apply|inspect)$/.test(request.path))).toEqual([]);
});
