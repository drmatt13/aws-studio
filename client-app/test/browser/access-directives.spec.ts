import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { test, expect, type StudioFixture } from "./support/test";
import { workbench } from "./support/scenarios";
import { parseDeclaredSchema } from "../../server/database";
import { accessFixture } from "../support/access-fixture";
const modules = undefined;
import { readClientAccess } from "aws-studio/database/client-access";

/** A standalone generic schema exercises access editing without adopting a policy. */
const contract = accessFixture;
const evidence = path.resolve(__dirname, "../../../output/playwright/access-editor");

// CodeMirror measures pointer dwell with Date.now() and schedules it with timers.
test.use({ fixedClock: false });

function serve(studio: StudioFixture, initial = contract) {
  const saved = workbench(), schema = parseDeclaredSchema(initial);
  let draft = initial;
  studio.reply("GET", "/api/database/workbench", (route) => route.fulfill({ json: { ...saved, source: initial, accessModules: modules, revision: schema.hash, validation: { ...saved.validation, sourceHash: schema.hash, schema } } }));
  studio.reply("POST", "/api/database/workbench/validate", (route) => {
    draft = route.request().postDataJSON().source as string;
    const valid = parse(draft, "contract.prisma").diagnostics.length === 0 && readClientAccess(draft, modules).problems.length === 0;
    return route.fulfill({ json: { ...saved.validation, sourceHash: draft, valid, schema: parseDeclaredSchema(draft), diagnostics: [] } });
  });
  return () => draft;
}

async function openSchema(page: Page, studio: StudioFixture, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await studio.goto("/database/schema");
  const editor = page.getByRole("textbox", { name: "Prisma schema source" });
  await expect(editor).toBeVisible();
  return editor;
}

async function jumpTo(page: Page, symbol: string) {
  await page.getByRole("combobox", { name: "Jump to model or enum" }).selectOption(symbol);
}

/** The colours a reader sees on one directive after syntax highlighting settles. */
function directiveColours(line: Locator) {
  return line.evaluate((element) => {
    const colours = new Set<string>();
    for (const category of ["identity", "role", "path", "keyword"]) {
      let token = element.querySelector(`.cm-access-${category}`);
      if (!token) continue;
      while (token.firstElementChild) token = token.firstElementChild;
      colours.add(getComputedStyle(token).color);
    }
    return colours.size;
  });
}

function pill(page: Page, target: string, rule: string) {
  return page.getByRole("button", { name: `Access for ${target}: ${rule}`, exact: true });
}

async function revealRule(page: Page, target: string, rule: string) {
  const badge = pill(page, target, rule);
  const line = await badge.getAttribute("data-access-line");
  await badge.click();
  const popup = page.getByRole("dialog", { name: `Access for ${target}`, exact: true });
  await popup.getByRole("button", { name: `Show line ${line} in source`, exact: true }).click();
  await expect(popup).toHaveCount(0);
  return page.locator(".cm-line", { hasText: `/// @access(${rule})` });
}

function screenshot(page: Page, name: string) {
  mkdirSync(evidence, { recursive: true });
  return page.screenshot({ path: path.join(evidence, `${test.info().project.name}-${name}.png`) });
}

for (const width of [1440, 390]) {
  test(`pills preserve model scope and inline enum rules at ${width}px`, async ({ page, studio }) => {
    serve(studio);
    await openSchema(page, studio, width);
    await jumpTo(page, "TeamInvitation");
    const rule = "read: email == auth.email || team.inviteMembers";
    await expect(pill(page, "TeamInvitation", rule)).toBeVisible();
    const chip = page.locator('.cm-access-scope-chip[data-access-model="TeamInvitation"]');
    await expect(chip).toHaveText("owner · email · Team inviteMembers");
    await expect(chip.locator(".cm-access-scope-dot")).toHaveCount(2);
    await expect(page.locator(".cm-line.cm-access-rail", { hasText: "model TeamInvitation {" })).toHaveAttribute("data-access-rail", "identity role");
    await expect(page.locator(".cm-line", { hasText: "/// @access(read: email == auth.email" })).toHaveCount(0);
    await screenshot(page, `${width}-invitation-pills`);
    const line = await revealRule(page, "TeamInvitation", rule);
    await expect.poll(() => directiveColours(line)).toBe(4);
    await expect(line.locator(".cm-access-path", { hasText: "team" })).toBeVisible();
    await expect(line.locator(".cm-access-role", { hasText: "inviteMembers" })).toBeVisible();
    await jumpTo(page, "ProjectRole");
    // A jump shows the declaration's rows above it, starting with read.
    await expect(pill(page, "ProjectRole", "read: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR, READONLY]")).toBeInViewport();
    await expect(pill(page, "ProjectRole", "uploadFiles: [OWNER, ADMIN, MANAGER]")).toBeVisible();
    const owner = pill(page, "ProjectRole.OWNER", "protected");
    await expect(owner).toHaveClass(/cm-access-annotation/);
    await expect(page.locator(".cm-line", { has: owner })).toContainText('OWNER       = "OWNER"');
    await expect(page.locator(".cm-line", { hasText: 'ADMIN       = "ADMIN"' }).locator(".cm-access-annotation")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Role permissions for ProjectRole" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, `${width}-membership-pills`);
    await owner.click();
    const popup = page.getByRole("dialog", { name: "Access for ProjectRole.OWNER" });
    const expression = popup.getByLabel("Access expression");
    await expect(expression).toHaveValue("protected");
    await expect(expression).toBeInViewport();
  });
}

test("a role value's annotation starts in one column after the enum's widest value", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "ProjectRole");
  const owner = pill(page, "ProjectRole.OWNER", "protected");
  const widest = page.locator(".cm-line", { hasText: 'CONTRIBUTOR = "CONTRIBUTOR"' });
  const columns = await page.evaluate(([annotation, line]) => {
    const text = annotation!.querySelector("span")!.getBoundingClientRect().left;
    const range = document.createRange();
    range.selectNodeContents(line!);
    const content = line!.getBoundingClientRect().left + parseFloat(getComputedStyle(line!).paddingLeft);
    const ch = range.getBoundingClientRect().width / line!.textContent!.length;
    return { column: (text - content) / ch, widest: line!.textContent!.trimEnd().length };
  }, [await owner.elementHandle(), await widest.elementHandle()] as const);
  expect(Math.abs(columns.column - (columns.widest + 2))).toBeLessThan(0.5);
});

test("a caret directly after a pill shows the rule's source, and leaving folds it again", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "TeamMember");
  const rule = "write: team.changeMemberRoles && !isMe(userId) && membershipStatus == ACTIVE";
  await expect(pill(page, "TeamMember.role", rule)).toBeVisible();
  const field = page.locator(".cm-line", { has: pill(page, "TeamMember.role", rule) });
  await field.click({ position: { x: 24, y: 8 } });
  await expect(pill(page, "TeamMember.role", rule)).toBeVisible();
  await page.keyboard.press("End");
  await expect(pill(page, "TeamMember.role", rule)).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: `/// @access(${rule})` })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await expect(pill(page, "TeamMember.role", rule)).toBeVisible();
});

test("hovering raw policy tokens explains the compiled rule", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "TeamInvitation");
  const raw = await revealRule(page, "TeamInvitation", "create: team.inviteMembers && email != auth.email");
  const token = raw.locator(".cm-access-role", { hasText: "inviteMembers" });
  // CodeMirror replaces its unhighlighted text node after the jump.
  await token.locator(".prisma-token-comment").hover();
  const card = page.locator(".cm-access-hover");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-category", "role");
  await expect(card).toContainText("inviteMembers in that Team");
  await expect(card).toContainText("OWNER, ADMIN");
});

test("a shared billing rule links both the model and the field to one source declaration", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "User");
  await page.locator('.cm-access-scope-chip[data-access-model="User"]').click();
  const inspector = page.getByRole("region", { name: "Prisma access inspector" });
  const groups = inspector.getByRole("region", { name: "Grouped field rules" });
  const billingRule = groups.getByRole("listitem").filter({ hasText: "privateStatus" });
  await expect(billingRule).toContainText("read: isMe(id), readonly");
  const sourceLink = billingRule.getByRole("button", { name: /^Show line \d+ in source$/ });
  const sourceLinkName = (await sourceLink.getAttribute("aria-label"))!;
  await sourceLink.click();

  await expect(inspector).toHaveCount(0);
  await page.locator(".cm-access-column").filter({ hasText: /^privateStatus$/ }).click();
  await page.keyboard.press("F12");
  await expect(page.locator(".cm-activeLine")).toContainText("PrivateStatus @default(INACTIVE)");
  await page.keyboard.press("Control+.");
  await expect(inspector.getByRole("heading", { name: "User.privateStatus" })).toBeVisible();
  await expect(inspector.getByText("Clients cannot edit it")).toBeVisible();
  await expect(inspector.getByRole("button", { name: sourceLinkName })).toBeVisible();
});

test("a role matrix opens in one click, stages independent grants and dismisses back to the editor", async ({ page, studio }) => {
  const draft = serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "Team");
  const chip = page.locator('.cm-access-scope-chip[data-access-model="Team"]');
  const source = page.locator('[data-ui="workbench-source-pane"]');
  const initialWidth = (await source.boundingBox())!.width;
  await chip.click();
  const scope = page.getByRole("dialog", { name: "Access for Team", exact: true });
  await expect(scope.getByText("Access · Role scope")).toBeVisible();
  expect((await source.boundingBox())!.width).toBe(initialWidth);
  await page.keyboard.press("Escape");
  await expect(chip).toBeFocused();

  await jumpTo(page, "ProjectRole");
  const trigger = page.getByRole("button", { name: "Role permissions for ProjectRole" });
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Access for ProjectRole" });
  const table = popup.getByRole("table", { name: "ProjectRole roles" });
  await expect(table.getByRole("button", { name: "MANAGER holds acceptChange. Toggle" })).toHaveAttribute("aria-pressed", "true");
  const axe = await new AxeBuilder({ page }).include('[data-ui="access-rule-popup"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map(({ id, nodes }) => `${id}: ${nodes.map((node) => node.failureSummary).join(", ")}`)).toEqual([]);
  await screenshot(page, "1440-role-matrix");
  await table.getByRole("button", { name: "CONTRIBUTOR does not hold acceptChange. Toggle" }).click();
  await expect(table.getByRole("button", { name: "CONTRIBUTOR holds acceptChange. Toggle" })).toHaveAttribute("aria-pressed", "true");
  await expect(table.getByRole("button", { name: "READONLY does not hold acceptChange. Toggle" })).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click(2, 2);
  await expect(popup).toHaveCount(0);
  await expect(pill(page, "ProjectRole", "acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR]")).toBeVisible();
  await page.getByRole("button", { name: "Validate draft", exact: true }).click();
  await expect.poll(draft).toContain("/// @access(acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR])");
  await expect(page.getByRole("button", { name: "Review source changes", exact: true })).toBeEnabled();
  expect(studio.requests.filter((request) => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
});

test("a laptop viewport fits every role column and keeps the selected policy in its popup", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1024);
  await page.setViewportSize({ width: 1024, height: 768 });
  await jumpTo(page, "ProjectRole");
  const trigger = page.getByRole("button", { name: "Role permissions for ProjectRole" });
  await trigger.focus();
  await trigger.press("Enter");
  const popup = page.getByRole("dialog", { name: "Access for ProjectRole" });
  const table = popup.getByRole("table", { name: "ProjectRole roles" });
  await expect(table).toBeVisible();
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(768);
  const lastCell = (await table.getByRole("button", { name: "READONLY does not hold uploadFiles. Toggle" }).boundingBox())!;
  expect(lastCell.y + lastCell.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  expect(await table.evaluate(element => element.parentElement!.scrollWidth <= element.parentElement!.clientWidth)).toBe(true);
  await screenshot(page, "1024-role-matrix");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("a caret at the end of a validated uncommented field offers presets", async ({ page, studio }) => {
  const draft = serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "Note");
  const hint = page.getByRole("button", { name: "Configure access for Note.name" });
  const line = page.locator(".cm-line").filter({ hasText: /^\s*name\s+String\s*$/ }).first();
  await line.hover();
  await expect(hint).toHaveCount(0);
  await line.click({ position: { x: 16, y: 10 } });
  await expect(hint).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(hint).toBeVisible();
  await page.keyboard.insertText(" // ordinary comment");
  await expect(page.getByText("Valid Prisma 8", { exact: true }).first()).toBeVisible();
  await expect(hint).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("End");
  await expect(hint).toBeVisible();
  await page.keyboard.insertText(" @map(");
  await expect(page.getByText("Invalid draft", { exact: true }).first()).toBeVisible();
  await expect(hint).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("End");
  await expect(hint).toBeVisible();
  await hint.click();
  const popup = page.getByRole("dialog", { name: "Access for Note.name" });
  const configure = popup.getByRole("button", { name: "Configure access", exact: true });
  await expect(configure).toHaveAttribute("aria-expanded", "true");
  await popup.getByLabel("Quick configuration").selectOption({ label: "Read-only field" });
  await expect(popup.getByLabel("Access expression")).toHaveValue("readonly");
  await popup.getByRole("button", { name: "Apply to draft" }).click();
  await page.keyboard.press("Escape");
  const field = pill(page, "Note.name", "readonly");
  await expect(page.locator(".cm-line", { has: field })).toContainText("String");
  await field.click();
  await expect(popup.getByLabel("Access expression")).toHaveValue("readonly");
  await popup.getByRole("button", { name: "Close access inspector" }).click();
  await page.getByRole("button", { name: "Validate draft", exact: true }).click();
  await expect.poll(draft).toMatch(/^  name\s+String\s+\/\/\/ @access\(readonly\)$/m);
  expect(studio.requests.filter((request) => /\/(save|install|execute|apply)$/.test(request.path))).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`an inline matrix replaces only its permission pills and edits the draft at ${width}px`, async ({ page, studio }) => {
    const source = contract.replace("/// @access(inviteMembers:", "/// Invites are managed inside the team.\n/// @access(inviteMembers:");
    const draft = serve(studio, source);
    await openSchema(page, studio, width);
    await jumpTo(page, "ProjectRole");
    const toggle = page.getByRole("switch", { name: "Show role permissions inline for ProjectRole" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const matrix = page.getByRole("region", { name: "ProjectRole inline role permissions" });
    const table = matrix.getByRole("table", { name: "ProjectRole roles" });
    await expect(table).toBeInViewport();
    await expect(page.locator('.cm-access-pill[data-access-target="ProjectRole"]')).toHaveCount(0);
    await expect(page.locator(".cm-line", { hasText: "Invites are managed inside the team." })).toBeVisible();
    await expect(pill(page, "ProjectRole.OWNER", "protected")).toBeAttached();
    // Each permission stays one code line tall: the matrix stands where its rows stood.
    const heights = await matrix.evaluate((element) => ({
      line: [...element.closest(".cm-content")!.querySelectorAll(".cm-line")].find((line) => line.textContent!.trim() === 'ADMIN       = "ADMIN"')!.getBoundingClientRect().height,
      rows: [...element.querySelectorAll("tbody tr")].map((row) => row.getBoundingClientRect().height),
    }));
    for (const row of heights.rows) expect(Math.abs(row - heights.line)).toBeLessThanOrEqual(1);
    await expect(table.getByRole("rowheader", { name: "read" })).toBeVisible();
    if (width === 390) {
      const scroll = await matrix.evaluate(element => {
        const scroller = element.querySelector(".overflow-x-auto")!;
        return { viewport: scroller.clientWidth, content: scroller.scrollWidth, panel: scroller.getBoundingClientRect().right };
      });
      expect(scroll.content).toBeGreaterThan(scroll.viewport);
      expect(scroll.panel).toBeLessThan(width);
    } else {
      const axe = await new AxeBuilder({ page }).include(".cm-inline-role-matrix, .cm-inline-role-switch")
        .withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(axe.violations.map(({ id }) => id)).toEqual([]);
    }
    await screenshot(page, `${width}-inline-role-matrix`);

    const cell = table.getByRole("button", { name: "CONTRIBUTOR does not hold acceptChange. Toggle" });
    await cell.press("Space");
    const granted = table.getByRole("button", { name: "CONTRIBUTOR holds acceptChange. Toggle" });
    await expect(granted).toBeFocused();
    await expect(granted).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(cell).toHaveAttribute("aria-pressed", "false");
    await expect(cell).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(granted).toHaveAttribute("aria-pressed", "true");

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Validate draft", exact: true }).click();
    await expect.poll(draft).toBe(source.replace("acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER]", "acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR]"));
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(matrix).toHaveCount(0);
    await expect(pill(page, "ProjectRole", "acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR]")).toBeVisible();
  });
}

test("Comments shows highlighted source and restores inline choices when switching back", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "ProjectRole");
  const toggle = page.getByRole("switch", { name: "Show role permissions inline for ProjectRole" });
  await toggle.click();
  const matrix = page.getByRole("region", { name: "ProjectRole inline role permissions" });
  await expect(matrix).toBeVisible();
  const controls = page.getByRole("group", { name: "Access display" });
  const comments = controls.getByRole("button", { name: "Comments", exact: true });
  await comments.click();
  await expect(comments).toHaveAttribute("aria-pressed", "true");
  await expect(matrix).toHaveCount(0);
  await expect(page.locator(".cm-access-pill, .cm-access-hint, .cm-access-scope-chip, .cm-access-rail")).toHaveCount(0);
  await expect(toggle).toHaveCount(0);
  const directive = page.locator(".cm-line", { hasText: "/// @access(acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER])" });
  await expect(directive.locator(".cm-access-role", { hasText: "acceptChange" })).toBeVisible();
  await directive.click();
  await page.keyboard.press("Control+.");
  await expect(page.getByRole("dialog", { name: "Access for ProjectRole", exact: true })).toHaveCount(0);
  await screenshot(page, "1440-highlighted-comments");
  await controls.getByRole("button", { name: "Interactive", exact: true }).click();
  await jumpTo(page, "Note");
  await jumpTo(page, "ProjectRole");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(matrix).toBeAttached();
  await expect(page.getByRole("button", { name: "Review source changes" })).toBeDisabled();
  await comments.click();
  await page.reload();
  await expect(comments).toHaveAttribute("aria-pressed", "true");
});

test("a diagram field opens the same popup by context menu and keyboard", async ({ page, studio }) => {
  serve(studio, "model User {\n  id String @id\n  name String\n}\n");
  await openSchema(page, studio, 1440);
  const mode = page.getByRole("button", { name: "Focus diagram", exact: true });
  await mode.click();
  const field = page.getByRole("button", { name: "Locate User.name" });
  await field.click({ button: "right" });
  const popup = page.getByRole("dialog", { name: "Access for User.name" });
  await expect(popup.getByLabel("Quick configuration")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await expect(field).toBeFocused();
  await field.press("Control+.");
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Close access inspector" }).click();
  await expect(field).toBeFocused();
});

test("a mistake is underlined at the word the compiler names, as you type", async ({ page, studio }) => {
  serve(studio);
  await openSchema(page, studio, 1440);
  await jumpTo(page, "Note");
  await revealRule(page, "Note", "read: isMe(ownerId)");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("x");
  const underline = page.locator(".cm-lintRange-error");
  await expect(underline).toHaveText("ownerIdx");
  await underline.hover();
  await expect(page.locator(".cm-tooltip-lint")).toContainText("ownerIdx");
});

test("an empty permission stays editable by keyboard on a narrow screen", async ({ page, studio }) => {
  serve(studio, contract.replace("enum ProjectRole {", "/// @access(exportNotes: [])\nenum ProjectRole {"));
  const editor = await openSchema(page, studio, 390);
  await jumpTo(page, "ProjectRole");
  await editor.focus();
  await page.keyboard.press("Control+.");
  const inspector = page.getByRole("region", { name: "Prisma access inspector" });
  const popup = page.getByRole("dialog", { name: "Access for ProjectRole" });
  await expect(popup).toBeVisible();
  await screenshot(page, "390-role-matrix");
  const table = inspector.getByRole("table", { name: "ProjectRole roles" });
  const cell = table.getByRole("button", { name: "READONLY does not hold exportNotes. Toggle" });
  await cell.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(table.getByRole("button", { name: "CONTRIBUTOR does not hold exportNotes. Toggle" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(cell).toBeFocused();
  await page.keyboard.press("Space");
  const granted = table.getByRole("button", { name: "READONLY holds exportNotes. Toggle" });
  await expect(granted).toBeFocused();
  await expect(granted).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(cell).toHaveAttribute("aria-pressed", "false");
  await expect(table.getByRole("rowheader", { name: "exportNotes" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
