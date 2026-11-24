import type { Locator } from "@playwright/test";
import { test, expect } from "./support/test";
import { workbench } from "./support/scenarios";
import { parseDeclaredSchema } from "../../server/database";

const viewportSelector = '[data-ui="schema-viewport"]';
const stageSelector = '[data-ui="schema-stage"]';

async function camera(stage: Locator) {
  return stage.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}

function translated(initial: Awaited<ReturnType<typeof camera>>, x: number, y: number) {
  // Computed transforms serialize CSS coordinates with limited decimal precision.
  return { x: expect.closeTo(initial.x + x, 2), y: expect.closeTo(initial.y + y, 2), zoom: initial.zoom };
}

function relatedWorkbench() {
  const saved = workbench(), schema = saved.validation.schema!;
  let source = "";
  const tables = ["Note", "Owner", "Task", "Audit"].map(model => {
    const start = source.length;
    source += `model ${model} {\n  id String @id\n  title String\n}\n`;
    const location = { ...schema.tables[0]!.source, start, end: source.length - 1 };
    return { ...schema.tables[0]!, id: model, model, table: model, source: location,
      columns: schema.tables[0]!.columns.map(column => ({ ...column,
        source: { ...location, start: source.indexOf(`  ${column.name} `, start) + 2 },
      })),
    };
  });
  const relations = [["Note", "Owner"], ["Owner", "Task"]].map(([from, to]) => ({
    id: `${from}-${to}`, name: `${from}-${to}`, from: from!, to: to!, fields: ["id"], references: ["id"],
    cardinality: "N:1" as const, nullable: false, onDelete: "Restrict", onUpdate: "Cascade", source: tables[0]!.source,
  }));
  return { ...saved, source, validation: { ...saved.validation, schema: { ...schema, tables, relations } } };
}

function accessWorkbench() {
  const saved = workbench();
  const source = `/// @access(read: id == auth.id || sentMessages.read || memberships.read && memberships.status == ACTIVE)
model User {
  id String @id
  sentMessages Message[] @relation("MessageSender")
  memberships Membership[]
  audits Audit[]
}
/// @access(read: senderId == auth.id)
model Message {
  id String @id
  senderId String
  sender User @relation("MessageSender", fields: [senderId], references: [id])
}
/// @access(read: personId == auth.id)
model Membership {
  id String @id
  personId String
  status MembershipStatus
  person User @relation(fields: [personId], references: [id])
}
model Audit {
  id String @id
  personId String
  person User @relation(fields: [personId], references: [id])
}
enum MembershipStatus {
  ACTIVE
  INACTIVE
}
`;
  const schema = parseDeclaredSchema(source);
  return { ...saved, source, revision: schema.hash,
    validation: { ...saved.validation, sourceHash: schema.hash, schema },
  };
}

for (const width of [1440, 390]) {
  test(`access relationships distinguish both rule endpoints and navigate inverse rules at ${width}px`, async ({ page, studio }) => {
    const saved = accessWorkbench();
    studio.reply("GET", "/api/database/workbench", route => route.fulfill({ json: saved }));
    await page.setViewportSize({ width, height: 1000 });
    await studio.goto("/database/schema");
    await page.getByRole("button", { name: width < 800 ? "Focus diagram" : "Split source and diagram", exact: true }).click();
    const connectors = page.locator('[data-ui="schema-connector"]');
    await expect(connectors).toHaveCount(3);
    const messages = connectors.filter({ hasText: "User.sentMessages · via" });
    await expect(messages).toHaveCount(1);
    await expect(messages.locator('[data-ui="schema-edge-line"]')).not.toHaveAttribute("stroke-dasharray");
    await expect(messages.locator('[data-ui="schema-edge-line"]')).toHaveAttribute("data-access-kinds", /via/);
    await expect(messages.locator('[data-ui="schema-edge-line"]')).toHaveCSS("stroke-dasharray", "none");
    await expect(page.locator('[data-ui="access-path-caption"]')).toHaveText("Select a table to trace how people reach its rows");
    await expect(messages.locator("tspan")).toHaveText(["N:1", "owner · via"]);
    await expect(messages).toContainText("Message.sender · owner");
    const memberships = connectors.filter({ hasText: "User.memberships · via(status: ACTIVE)" });
    await expect(memberships).toHaveCount(1);
    await expect(memberships.locator('[data-ui="schema-edge-line"]')).not.toHaveAttribute("stroke-dasharray");
    await expect(memberships.locator("tspan")).toHaveText(["N:1", "owner · via"]);
    const plain = connectors.filter({ hasNotText: /User\.(sentMessages|memberships)/ });
    await expect(plain).toHaveCount(1);
    await expect(plain.locator('[data-ui="schema-edge-line"]')).not.toHaveAttribute("stroke-dasharray");
    // Access edges share the plain relationship stroke until a table is traced.
    const plainStroke = await plain.locator('[data-ui="schema-edge-line"]').evaluate(line => getComputedStyle(line).stroke);
    expect(plainStroke).not.toBe("none");
    await expect(messages.locator('[data-ui="schema-edge-line"]')).toHaveCSS("stroke", plainStroke);
    await expect(memberships.locator('[data-ui="schema-edge-line"]')).toHaveCSS("stroke", plainStroke);
    await expect(plain.locator("text")).toHaveText("N:1");

    await page.getByRole("button", { name: "Select table User", exact: true }).click();
    // Selected, the paths by which people reach User rows are drawn in their access colors.
    await expect(messages).toHaveAttribute("data-access-path", "true");
    await expect(memberships).toHaveAttribute("data-access-path", "true");
    await expect(plain).not.toHaveAttribute("data-access-path", "true");
    const colors = await page.locator('[data-ui="schema-edge-line"]').evaluateAll((lines) => lines.map((line) => ({ kinds: line.getAttribute("data-access-kinds"), stroke: getComputedStyle(line).stroke })));
    expect(colors.some((line) => line.kinds?.includes("via") && colors.some((other) => !other.kinds && other.stroke !== line.stroke))).toBe(true);
    await expect(page.locator('[data-ui="access-path-caption"]')).toHaveText("Colored: how people reach User rows");
    // Diagram-only navigation first opens the source pane, then reveals its
    // selection on the next frame. Wait for that focus transfer before Enter.
    await expect(page.getByRole("textbox", { name: "Prisma schema source" })).toBeFocused();
    const trigger = page.getByRole("button", { name: "Schema details", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "Schema details", exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByRole("button", { name: "Locate User.memberships · via(status: ACTIVE)", exact: true })).toBeVisible();
    const via = details.getByRole("button", { name: "Locate User.sentMessages · via", exact: true });
    await via.focus();
    await page.keyboard.press("Enter");
    await expect(details).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Prisma schema source" })).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain("sentMessages");
    await expect(page.getByRole("button", { name: "Review source changes", exact: true })).toBeDisabled();
    expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
  });
}

test("diagram pans in every direction even when it fits, without turning a drag into source navigation", async ({ page, studio }) => {
  await studio.goto("/database");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const viewport = page.locator(viewportSelector), stage = page.locator(stageSelector);
  const bounds = (await viewport.boundingBox())!;
  const initial = await camera(stage);
  const x = bounds.x + bounds.width - 25, y = bounds.y + bounds.height - 60;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 130, y - 60, { steps: 8 });
  await expect(viewport).toHaveCSS("cursor", "grabbing");
  await page.mouse.up();
  await expect(viewport).toHaveCSS("cursor", "grab");
  expect(await camera(stage)).toEqual(translated(initial, -130, -60));
  await page.mouse.move(x - 130, y - 60);
  await page.mouse.down();
  await page.mouse.move(x + 10, y + 30, { steps: 8 });
  await page.mouse.up();
  expect(await camera(stage)).toEqual(translated(initial, 10, 30));

  const heading = page.getByRole("button", { name: "Select table Note", exact: true });
  const card = (await heading.boundingBox())!;
  await page.mouse.move(card.x + 70, card.y + 20);
  await page.mouse.down();
  await page.mouse.move(card.x + 130, card.y + 50, { steps: 6 });
  await page.mouse.up();
  await expect(heading).toHaveAttribute("aria-pressed", "false");
  await expect(viewport).toBeFocused();
  await heading.click();
  await expect(heading).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Prisma schema source" })).toBeFocused();
  expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
});

test("wheel, keyboard, zoom and fit share the same camera and survive layout changes", async ({ page, studio }) => {
  await studio.goto("/database");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const viewport = page.locator(viewportSelector), stage = page.locator(stageSelector);
  const bounds = (await viewport.boundingBox())!;
  const initial = await camera(stage);
  await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + bounds.height - 20);
  await page.mouse.wheel(110, 75);
  await expect.poll(() => camera(stage)).toEqual(translated(initial, -110, -75));
  await viewport.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowUp");
  expect(await camera(stage)).toEqual(translated(initial, -70, 45));
  const beforeZoom = await camera(stage);
  const width = await viewport.evaluate(element => element.clientWidth);
  const worldX = (width / 2 - beforeZoom.x) / beforeZoom.zoom;
  await page.keyboard.press("+");
  const afterZoom = await camera(stage);
  expect(afterZoom.zoom).toBeCloseTo(initial.zoom * 1.2);
  expect((width / 2 - afterZoom.x) / afterZoom.zoom).toBeCloseTo(worldX);
  const anchor = { x: Math.round(bounds.x + 100), y: Math.round(bounds.y + 100) };
  const localX = anchor.x - bounds.x, localY = anchor.y - bounds.y;
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -20);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await camera(stage)).zoom).toBeGreaterThan(afterZoom.zoom);
  const afterPinch = await camera(stage);
  expect((localX - afterPinch.x) / afterPinch.zoom).toBeCloseTo((localX - afterZoom.x) / afterZoom.zoom, 1);
  expect((localY - afterPinch.y) / afterPinch.zoom).toBeCloseTo((localY - afterZoom.y) / afterZoom.zoom, 1);
  await page.getByRole("button", { name: "Focus diagram", exact: true }).click();
  expect(await camera(stage)).toEqual(afterPinch);
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  await studio.settle();
  expect(await camera(stage)).toEqual(afterPinch);
  await viewport.focus();
  await page.keyboard.press("0");
  const table = (await page.locator('[data-ui="schema-table"]').boundingBox())!;
  expect(table.x).toBeGreaterThan(bounds.x);
  expect(table.y).toBeGreaterThan(bounds.y);
  expect(table.x + table.width).toBeLessThan(bounds.x + bounds.width);
  expect(table.y + table.height).toBeLessThan(bounds.y + bounds.height);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Tab");
  const heading = page.getByRole("button", { name: "Select table Note", exact: true });
  await expect(heading).toBeFocused();
  const focused = (await heading.boundingBox())!;
  expect(focused.x).toBeGreaterThanOrEqual(bounds.x);
  expect(focused.x + focused.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(await viewport.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
});

test("100% fits every table on load, resize and reset, including schemas below the former minimum scale", async ({ page, studio }) => {
  const saved = relatedWorkbench(), schema = saved.validation.schema!;
  const tables = Array.from({ length: 18 }, (_, index) => ({ ...schema.tables[0]!,
    id: `Table${index}`, model: `Table${index}`, table: `Table${index}`,
    columns: Array.from({ length: 60 }, (_, field) => ({ ...schema.tables[0]!.columns[0]!, name: field ? `field${field}` : "id" })),
  }));
  studio.reply("GET", "/api/database/workbench", route => route.fulfill({ json: {
    ...saved, validation: { ...saved.validation, schema: { ...schema, tables, relations: [] } },
  } }));
  await studio.goto("/database/schema");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const reset = page.getByRole("button", { name: "Reset schema view to 100%", exact: true });
  const allVisible = async () => {
    await expect(reset).toHaveText("100%");
    await expect.poll(() => page.locator(viewportSelector).evaluate(viewport => {
      const bounds = viewport.getBoundingClientRect();
      return [...viewport.querySelectorAll('[data-ui="schema-table"]')].every(table => {
        const rect = table.getBoundingClientRect();
        return rect.left >= bounds.left + 8 && rect.top >= bounds.top + 8
          && rect.right <= bounds.right - 8 && rect.bottom <= bounds.bottom - 8;
      });
    })).toBe(true);
    await expect(page.locator('[data-ui="schema-table"]')).toHaveCount(18);
  };
  await allVisible();
  await page.getByRole("button", { name: "Focus diagram", exact: true }).click();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await allVisible();
  }
  expect((await camera(page.locator(stageSelector))).zoom).toBeLessThan(0.15);
  const positions = () => page.locator('[data-ui="schema-table"]').evaluateAll(tables => tables.map(table => table.getAttribute("style")));
  const beforeSearch = await positions();
  await page.getByRole("searchbox", { name: "Find a table or column" }).fill("Table1");
  await expect(page.getByRole("status").filter({ hasText: "matching tables" })).toBeVisible();
  expect(await positions()).toEqual(beforeSearch);
  await page.getByRole("button", { name: "Clear schema search" }).click();
  await allVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(reset).toHaveText("120%");
  await page.locator(viewportSelector).focus();
  await page.keyboard.press("ArrowRight");
  const manualPositions = await positions(), manualCamera = await camera(page.locator(stageSelector));
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await positions()).toEqual(manualPositions);
  expect(await camera(page.locator(stageSelector))).toEqual(manualCamera);
  await reset.click();
  await allVisible();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Fit schema", exact: true }).click();
  await allVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.locator(viewportSelector).focus();
  await page.keyboard.press("0");
  await allVisible();
  expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
});

test("focus selection centers the table, dims its neighbors and follows a new selection", async ({ page, studio }) => {
  const saved = relatedWorkbench();
  studio.reply("GET", "/api/database/workbench", route => route.fulfill({ json: saved }));
  await studio.goto("/database");
  await page.getByRole("button", { name: "Split source and diagram", exact: true }).click();
  const focus = page.getByRole("checkbox", { name: "Focus selection", exact: true });
  await expect(focus).toBeEnabled();
  await page.getByRole("button", { name: "Fit schema", exact: true }).click();
  const initial = await camera(page.locator(stageSelector));
  await focus.focus();
  await page.keyboard.press("Space");
  await expect(focus).toBeChecked();
  expect(await camera(page.locator(stageSelector))).toEqual(initial);
  await page.getByRole("button", { name: "Select table Note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select table Note", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await camera(page.locator(stageSelector))).not.toEqual(initial);
  const table = (name: string) => page.locator('[data-ui="schema-table"]').filter({ has: page.getByRole("button", { name: `Select table ${name}`, exact: true }) });
  await expect(table("Note")).toHaveCSS("opacity", "1");
  await expect(table("Owner")).toHaveCSS("opacity", "0.6");
  await expect(table("Task")).toHaveCSS("opacity", "0.25");
  await expect(table("Audit")).toHaveCSS("opacity", "0.25");
  await expect(page.locator('[data-ui="schema-connector"]').nth(0)).toHaveCSS("opacity", "1");
  await expect(page.locator('[data-ui="schema-connector"]').nth(1)).toHaveCSS("opacity", "0.25");
  const viewport = (await page.locator(viewportSelector).boundingBox())!;
  const bounds = (await table("Note").boundingBox())!;
  expect(Math.abs(bounds.x + bounds.width / 2 - (viewport.x + viewport.width / 2))).toBeLessThan(2);
  expect(Math.abs(bounds.y + bounds.height / 2 - (viewport.y + viewport.height / 2))).toBeLessThan(2);
  expect(bounds.width).toBeLessThan(viewport.width * 0.65);
  expect(bounds.height).toBeLessThan(viewport.height * 0.65);
  await page.getByRole("button", { name: "Fit schema", exact: true }).click();
  await page.getByRole("button", { name: "Select table Audit", exact: true }).click();
  await expect(table("Audit")).toHaveCSS("opacity", "1");
  await expect(table("Note")).toHaveCSS("opacity", "0.25");
  await focus.uncheck();
  await expect(table("Note")).toHaveCSS("opacity", "1");
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole("button", { name: "Focus diagram", exact: true }).click();
  await focus.check();
  const mobileViewport = (await page.locator(viewportSelector).boundingBox())!;
  const mobileTable = (await table("Audit").boundingBox())!;
  expect(mobileTable.width).toBeLessThan(mobileViewport.width * 0.65);
  expect(mobileTable.height).toBeLessThan(mobileViewport.height * 0.65);
});

test("mobile touch drag pans the diagram and leaves source untouched", async ({ page, context, studio }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await studio.goto("/database");
  await page.getByRole("button", { name: "Focus diagram", exact: true }).click();
  const viewport = page.locator(viewportSelector), stage = page.locator(stageSelector);
  const bounds = (await viewport.boundingBox())!;
  const initial = await camera(stage);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 45;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 70, y: y - 50 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => camera(stage)).toEqual({ ...initial,
    x: expect.closeTo(initial.x - 70, 3), y: expect.closeTo(initial.y - 50, 3) });
  await expect(viewport).toHaveCSS("cursor", "grab");
  await session.detach();
  expect(studio.requests.filter(request => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
});
