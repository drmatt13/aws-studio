import { test, expect } from "./support/test";

test("Source mode owns one socket panel and switching closes the previous connection", async ({ page, studio }) => {
  let localClosed = false;
  await page.routeWebSocket(/^ws:\/\/studio-fixture\.invalid\/local\?/, socket => {
    socket.onClose(() => { localClosed = true; });
    socket.onMessage(message => { studio.sockets.push(String(message)); socket.send(JSON.stringify({ received: JSON.parse(String(message)) })); });
  });
  await studio.goto("/websockets");
  const local = page.getByRole("region", { name: "Local", exact: true });
  const aws = page.getByRole("region", { name: "AWS", exact: true });
  await local.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(local.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await expect(aws).toHaveCount(0);
  await local.getByRole("textbox", { name: "Send payload", exact: true }).fill('{"action":"fixture"}');
  await local.getByRole("button", { name: "Send payload to Local" }).click();
  await expect(local.getByRole("log")).toContainText("1 item");
  // This selector belongs to the third-party JSON viewer, whose collapsed tree has no button role.
  await local.getByRole("log").locator(".collapsed-icon:visible").click();
  await expect(local.getByRole("log")).toContainText("received");
  await local.getByRole("textbox", { name: "Send payload", exact: true }).fill("invalid next payload");
  await expect(local.getByRole("button", { name: "Send payload to Local" })).toBeDisabled();
  await expect(local.getByRole("log")).toContainText("received");
  expect(studio.sockets).toEqual(['{"action":"fixture"}']);
  await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Production", exact: true }).click();
  await expect(local).toHaveCount(0);
  await expect.poll(() => localClosed).toBe(true);
  await expect(aws.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await aws.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(aws.getByRole("log")).toContainText("Connected to WebSocket");
  await expect(aws.getByRole("log")).not.toContainText("received");
  await aws.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(aws.getByRole("log")).toContainText("Disconnected from WebSocket");
  await aws.getByRole("textbox", { name: "AWS connection URL" }).fill("invalid");
  await expect(aws.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
});

test("a rejected socket constructor recovers and plain-text replies remain inspectable", async ({ page, studio }) => {
  await studio.goto("/websockets");
  // Playwright intercepts native WebSocket construction; inject this failure before
  // its transport so the normal strict fixture allowlist remains unchanged.
  await page.evaluate(() => {
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        if (args[0] === "ws://studio-fixture.invalid/reject-construction") throw new DOMException("Fixture constructor rejection", "SyntaxError");
        return Reflect.construct(target, args);
      },
    });
  });
  const local = page.getByRole("region", { name: "Local", exact: true });
  const url = local.getByRole("textbox", { name: "Local connection URL" });
  await url.fill("ws://studio-fixture.invalid/reject-construction");
  await local.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(local.getByRole("log")).toContainText("Failed to connect to WebSocket");
  await expect(local.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await page.routeWebSocket("ws://studio-fixture.invalid/text-recovery", socket => {
    socket.onMessage(() => { for (const frame of ["plain fixture reply", '{"broken":', "false", "0", "null", ""]) socket.send(frame); });
  });
  await url.fill("ws://studio-fixture.invalid/text-recovery");
  await local.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(local.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await local.getByRole("button", { name: "Send payload to Local" }).click();
  const log = local.getByRole("log");
  await expect(log.locator(".collapsed-icon:visible")).toHaveCount(6);
  // Expanding removes this class, so always resolve the first remaining root.
  for (let index = 0; index < 6; index++) await log.locator(".collapsed-icon:visible").first().click();
  await expect(log.locator(".collapsed-icon:visible")).toHaveCount(0);
  for (const text of ["plain fixture reply", '{"broken":', "false", "0", "NULL"]) await expect(log).toContainText(text);
  await local.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(log).toContainText("Disconnected from WebSocket");
});
